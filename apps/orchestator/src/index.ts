import "dotenv/config";
import {
    BackendToOrchestator,
    OrchestatorToControl,
    ControlToOrchestrator,
    CREATE_PROJECT,
    PROJECT_BUILD,
    PROJECT_RUN,
    PROMPT,
    OrchestatorToBackend,
    PROJECT_BUILD_FAILED,
    PROJECT_BUILD_SUCCESS,
    PROJECT_FAILED,
    PROJECT_RUN_SUCCESS,
    PROMPT_RESPONSE,
    PROJECT_INITIALIZED,
    PROJECT_CREATED,
    PROJECT_RUN_FAILED,
    ServingToOrchestrator,
    OrchestatorToServing,
} from "types";

import { createProjectPod } from "./handler/project";

import type {
    BackendPayload,
    ControlMessage,
    ServingMessage,
} from "./types";
import { toK8sName } from "./lib";
import {
    RedisManager,
    publishEnvelope,
    parseStreamFields,
    readGroupLoop,
    StreamGroups,
} from "shared-redis";

console.log("Orchestrator started with env:", {
    NODE_ENV: process.env.NODE_ENV,
    REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
    SKIP_K8S: process.env.SKIP_K8S || "true",
});

const serverResponses = new Map<string, (v: ServingMessage) => void>();
const controlResponses = new Map<string, (v: ControlMessage) => void>();

function waitForServer(projectId: string, timeoutMs = 60_000) {
    return new Promise<ServingMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
            serverResponses.delete(projectId);
            reject(new Error(`Serving pod timeout for ${projectId}`));
        }, timeoutMs);
        serverResponses.set(projectId, (value) => {
            clearTimeout(timer);
            resolve(value);
        });
    });
}

function waitForControl(projectId: string, timeoutMs = 60_000) {
    return new Promise<ControlMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
            controlResponses.delete(projectId);
            reject(new Error("Control pod timeout"));
        }, timeoutMs);

        controlResponses.set(projectId, (value) => {
            clearTimeout(timer);
            resolve(value);
        });
    });
}

async function ListenBackend() {
    await readGroupLoop({
        stream: BackendToOrchestator,
        group: StreamGroups.orch,
        readerRole: "orchBackend",
        handler: async (_id, fields) => {
            const envelope = parseStreamFields(fields);
            const type = envelope.type;

            // Legacy backend wrote flat type + payload JSON string;
            // new writers use { data: { type, projectId, ... } } or nested payload object.
            let payload: BackendPayload;
            if (
                envelope.payload &&
                typeof envelope.payload === "object" &&
                envelope.payload !== null &&
                "projectId" in (envelope.payload as object)
            ) {
                payload = envelope.payload as BackendPayload;
            } else if (envelope.projectId) {
                payload = {
                    projectId: envelope.projectId as string,
                    jobId: (envelope.jobId as string) || "",
                    userId: (envelope.userId as string) || "",
                    prompt:
                        typeof envelope.prompt === "string"
                            ? envelope.prompt
                            : typeof envelope.payload === "string"
                              ? envelope.payload
                              : undefined,
                };
            } else if (typeof envelope.payload === "string") {
                payload = JSON.parse(envelope.payload) as BackendPayload;
            } else {
                console.error("[orch] Unrecognized backend message:", envelope);
                return;
            }

            console.log(payload);
            const { projectId, prompt } = payload;

            switch (type) {
                case CREATE_PROJECT:
                    createProject(projectId).catch(console.error);
                    break;
                case PROJECT_BUILD:
                    buildProject(projectId).catch(console.error);
                    break;
                case PROJECT_RUN:
                    runProject(projectId).catch(console.error);
                    break;
                case PROMPT:
                    if (!prompt) {
                        console.log(`[${projectId}] Prompt missing payload`);
                        break;
                    }
                    handlePrompt(projectId, prompt).catch(console.error);
                    break;
                default:
                    console.log(`[orch] Unknown backend type: ${type}`);
            }
        },
    });
}

async function ListenControlPod() {
    await readGroupLoop({
        stream: ControlToOrchestrator,
        group: StreamGroups.orch,
        readerRole: "orchControl",
        handler: async (_id, fields) => {
            const data = parseStreamFields(fields) as ControlMessage & {
                type: string;
                projectId: string;
            };
            const { projectId, type } = data;
            if (!projectId) return;
            console.log(`[${projectId}] Received ${type} from control`);

            if (type !== PROJECT_INITIALIZED) {
                const resolver = controlResponses.get(projectId);
                if (resolver) {
                    resolver(data);
                    controlResponses.delete(projectId);
                }
            }
        },
    });
}

async function ListenServingPod() {
    await readGroupLoop({
        stream: ServingToOrchestrator,
        group: StreamGroups.orch,
        readerRole: "orchServing",
        handler: async (_id, fields) => {
            const data = parseStreamFields(fields) as ServingMessage & {
                type: string;
                projectId: string;
                payload?: string;
            };
            const { projectId, type, payload } = data;
            if (!projectId || !type) return;

            console.log(`[${projectId}] Received ${type} from serving`);

            const validRunTypes = [
                PROJECT_RUN_SUCCESS,
                PROJECT_RUN_FAILED,
                PROJECT_FAILED,
            ];
            if (validRunTypes.includes(type)) {
                const resolver = serverResponses.get(projectId);
                if (resolver) {
                    resolver(data);
                    serverResponses.delete(projectId);
                }
            }

            switch (type) {
                case PROJECT_CREATED:
                    await publishEnvelope(OrchestatorToBackend, {
                        projectId,
                        type: PROJECT_INITIALIZED,
                    });
                    console.log(
                        `[${projectId}] Forwarded PROJECT_CREATED as PROJECT_INITIALIZED to backend`,
                    );
                    break;
                case PROJECT_FAILED:
                    await publishEnvelope(OrchestatorToBackend, {
                        projectId,
                        type: PROJECT_FAILED,
                        payload: payload || "",
                    });
                    console.log(
                        `[${projectId}] Forwarded PROJECT_FAILED to backend`,
                    );
                    break;
                default:
                    break;
            }
        },
    });
}

async function createProject(projectId: string) {
    const skipK8s = process.env.SKIP_K8S?.toLowerCase() === "true";
    console.log(`[${projectId}] SKIP_K8S = ${skipK8s}`);

    if (!skipK8s) {
        try {
            await createProjectPod(toK8sName(projectId));
            console.log(`[${projectId}] K8s pod created`);
        } catch (err) {
            console.error(`[${projectId}] K8s pod creation failed:`, err);
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                type: PROJECT_FAILED,
                payload: String(err),
            });
            return;
        }
    } else {
        console.log(
            `[${projectId}] Skipping K8s pod creation (SKIP_K8S=true)`,
        );
    }

    await publishEnvelope(OrchestatorToControl, {
        type: PROJECT_INITIALIZED,
        projectId,
    });
    console.log(
        `[${projectId}] PROJECT_INITIALIZED sent to control, waiting for async response from serving`,
    );
}

async function buildProject(projectId: string) {
    console.log("BUILD_PROJECT is being called");

    await publishEnvelope(OrchestatorToControl, {
        projectId,
        type: PROJECT_BUILD,
    });

    try {
        const response = await waitForControl(projectId);
        if (response.type === PROJECT_BUILD_SUCCESS) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                type: PROJECT_BUILD_SUCCESS,
            });
            console.log(`[${projectId}] Build success forwarded`);
        } else if (response.type === PROJECT_BUILD_FAILED) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                type: PROJECT_BUILD_FAILED,
                payload: response.payload || "",
            });
            console.log(`[${projectId}] Build failed forwarded`);
        } else if (response.type === PROJECT_FAILED) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                type: PROJECT_FAILED,
                payload: response.payload || "",
            });
        }
    } catch (err) {
        console.error(`[${projectId}] Build timeout or error:`, err);
        await publishEnvelope(OrchestatorToBackend, {
            projectId,
            type: PROJECT_BUILD_FAILED,
            payload: String(err),
        });
    }
}

async function runProject(projectId: string) {
    console.log(`[${projectId}] RUN_PROJECT called`);

    await publishEnvelope(OrchestatorToServing, {
        projectId,
        type: PROJECT_RUN,
    });

    try {
        const response = await waitForServer(projectId);
        if (response.type === PROJECT_RUN_SUCCESS) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                type: PROJECT_RUN_SUCCESS,
            });
            console.log(`[${projectId}] Run success forwarded`);
        } else if (response.type === PROJECT_RUN_FAILED) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                type: PROJECT_RUN_FAILED,
                payload: response.payload || "",
            });
            console.log(`[${projectId}] Run failed forwarded`);
        } else if (response.type === PROJECT_FAILED) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                type: PROJECT_FAILED,
                payload: response.payload || "",
            });
        }
    } catch (err) {
        console.error(`[${projectId}] Run timeout or error:`, err);
        await publishEnvelope(OrchestatorToBackend, {
            projectId,
            type: PROJECT_RUN_FAILED,
            payload: String(err),
        });
    }
}

async function handlePrompt(projectId: string, prompt: string) {
    console.log(`[${projectId}] PROMPT called`);
    await publishEnvelope(OrchestatorToControl, {
        projectId,
        type: PROMPT,
        payload: prompt,
    });

    try {
        const response = await waitForControl(projectId);
        if (response.type === PROMPT_RESPONSE) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                type: PROMPT_RESPONSE,
                payload: response.payload || "",
            });
            console.log(`[${projectId}] Prompt response forwarded`);
        } else {
            console.log(
                `[${projectId}] Unexpected prompt response: ${response.type}`,
            );
        }
    } catch (err) {
        console.error(`[${projectId}] Prompt timeout or error:`, err);
        await publishEnvelope(OrchestatorToBackend, {
            projectId,
            type: PROMPT_RESPONSE,
            payload: "Error: " + String(err),
        });
    }
}

async function shutdown(signal: string) {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    try {
        await RedisManager.quitAll();
        console.log("All Redis connections closed.");
    } catch (err) {
        console.error("Error during shutdown:", err);
    }
    process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
    await RedisManager.getWriter();
    console.log("All Redis clients connected.");

    await Promise.all([
        ListenBackend(),
        ListenControlPod(),
        ListenServingPod(),
    ]);
}

main().catch((error) => {
    console.error("Fatal error in Orchestrator:", error);
    process.exit(1);
});
