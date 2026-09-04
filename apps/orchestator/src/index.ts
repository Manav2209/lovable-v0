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

import type {
    BackendPayload,
    ControlMessage,
    ServingMessage,
} from "./types";
import { createProjectPod, registerHostIngressRoute } from "./handler/project";
import { CorrelationResolver, idKey } from "./correlation";
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

const serverResolver = new CorrelationResolver<ServingMessage>();
const controlResolver = new CorrelationResolver<ControlMessage>();
/** Initial create prompts to run automatically after PROJECT_CREATED */
const pendingInitialPrompts = new Map<string, string>();

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
            const { projectId, prompt, jobId } = payload;

            switch (type) {
                case CREATE_PROJECT:
                    if (prompt) {
                        pendingInitialPrompts.set(projectId, prompt);
                    }
                    createProject(projectId, jobId).catch(console.error);
                    break;
                case PROJECT_BUILD:
                    buildProject(projectId, jobId).catch(console.error);
                    break;
                case PROJECT_RUN:
                    runProject(projectId, jobId).catch(console.error);
                    break;
                case PROMPT:
                    if (!prompt) {
                        console.log(`[${projectId}] Prompt missing payload`);
                        break;
                    }
                    handlePrompt(projectId, jobId, prompt).catch(console.error);
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
                const key = idKey(projectId, data.jobId as string | undefined);
                const matched = controlResolver.resolve(key, data);
                if (!matched && (
                    type === PROJECT_BUILD_SUCCESS ||
                    type === PROJECT_BUILD_FAILED ||
                    type === PROJECT_FAILED ||
                    type === PROMPT_RESPONSE
                )) {
                    // Late reply after HTTP waiter timed out — still notify backend.
                    await publishEnvelope(OrchestatorToBackend, {
                        projectId,
                        jobId: data.jobId as string | undefined,
                        type,
                        payload: data.payload || "",
                        success: data.success,
                    });
                    console.log(
                        `[${projectId}] Late ${type} forwarded to backend (no waiter)`,
                    );
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
                const key = idKey(projectId, data.jobId as string | undefined);
                const matched = serverResolver.resolve(key, data);
                if (!matched) {
                    await publishEnvelope(OrchestatorToBackend, {
                        projectId,
                        jobId: data.jobId as string | undefined,
                        type,
                        payload: payload || "",
                    });
                    console.log(
                        `[${projectId}] Late ${type} forwarded to backend (no waiter)`,
                    );
                }
            }

            if (type === PROJECT_RUN_SUCCESS) {
                // Ensure host ingress points at localhost NodePort (not cluster DNS).
                await registerHostIngressRoute(projectId).catch(console.error);
            }

            switch (type) {
                case PROJECT_CREATED:
                    await publishEnvelope(OrchestatorToBackend, {
                        projectId,
                        jobId: data.jobId as string | undefined,
                        type: PROJECT_INITIALIZED,
                    });
                    console.log(
                        `[${projectId}] Forwarded PROJECT_CREATED as PROJECT_INITIALIZED to backend`,
                    );
                    {
                        const initialPrompt = pendingInitialPrompts.get(projectId);
                        if (initialPrompt) {
                            pendingInitialPrompts.delete(projectId);
                            console.log(
                                `[${projectId}] Auto-running initial prompt after create`,
                            );
                            // Brief delay so the workspace can open and attach SSE first.
                            setTimeout(() => {
                                // Fire-and-forget initial prompt (no backend HTTP
                                // waiter), so it carries no correlated jobId; the
                                // PROMPT_RESPONSE is surfaced via SSE.
                                handlePrompt(projectId, undefined, initialPrompt).catch(
                                    console.error,
                                );
                            }, 2500);
                        }
                    }
                    break;
                case PROJECT_FAILED:
                    await publishEnvelope(OrchestatorToBackend, {
                        projectId,
                        jobId: data.jobId as string | undefined,
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

async function createProject(projectId: string, jobId?: string) {
    const skipK8s = process.env.SKIP_K8S?.toLowerCase() === "true";
    console.log(`[${projectId}] SKIP_K8S = ${skipK8s}`);

    if (!skipK8s) {
        try {
            await createProjectPod(projectId);
            console.log(`[${projectId}] K8s pod created`);
        } catch (err) {
            console.error(`[${projectId}] K8s pod creation failed:`, err);
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                jobId,
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
        jobId,
    });
    console.log(
        `[${projectId}] PROJECT_INITIALIZED sent to control, waiting for async response from serving`,
    );
}

async function buildProject(projectId: string, jobId?: string) {
    console.log("BUILD_PROJECT is being called");

    await publishEnvelope(OrchestatorToControl, {
        projectId,
        jobId,
        type: PROJECT_BUILD,
    });

    const key = idKey(projectId, jobId);

    try {
        const response = await controlResolver.wait(key, 600_000, "Control pod");
        if (response.type === PROJECT_BUILD_SUCCESS) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                jobId,
                type: PROJECT_BUILD_SUCCESS,
            });
            console.log(`[${projectId}] Build success forwarded`);
        } else if (response.type === PROJECT_BUILD_FAILED) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                jobId,
                type: PROJECT_BUILD_FAILED,
                payload: response.payload || "",
            });
            console.log(`[${projectId}] Build failed forwarded`);
        } else if (response.type === PROJECT_FAILED) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                jobId,
                type: PROJECT_FAILED,
                payload: response.payload || "",
            });
        }
    } catch (err) {
        console.error(`[${projectId}] Build timeout or error:`, err);
        await publishEnvelope(OrchestatorToBackend, {
            projectId,
            jobId,
            type: PROJECT_BUILD_FAILED,
            payload: String(err),
        });
    }
}

async function runProject(projectId: string, jobId?: string) {
    console.log(`[${projectId}] RUN_PROJECT called`);

    await publishEnvelope(OrchestatorToServing, {
        projectId,
        jobId,
        type: PROJECT_RUN,
    });

    const key = idKey(projectId, jobId);

    try {
        const response = await serverResolver.wait(key, 600_000, "Serving pod");
        if (response.type === PROJECT_RUN_SUCCESS) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                jobId,
                type: PROJECT_RUN_SUCCESS,
                payload: response.payload || "",
            });
            console.log(`[${projectId}] Run success forwarded`);
        } else if (response.type === PROJECT_RUN_FAILED) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                jobId,
                type: PROJECT_RUN_FAILED,
                payload: response.payload || "",
            });
            console.log(`[${projectId}] Run failed forwarded`);
        } else if (response.type === PROJECT_FAILED) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                jobId,
                type: PROJECT_FAILED,
                payload: response.payload || "",
            });
        }
    } catch (err) {
        console.error(`[${projectId}] Run timeout or error:`, err);
        await publishEnvelope(OrchestatorToBackend, {
            projectId,
            jobId,
            type: PROJECT_RUN_FAILED,
            payload: String(err),
        });
    }
}

async function handlePrompt(projectId: string, jobId: string | undefined, prompt: string) {
    console.log(`[${projectId}] PROMPT called`);
    await publishEnvelope(OrchestatorToControl, {
        projectId,
        jobId,
        type: PROMPT,
        payload: prompt,
    });

    try {
        const response = await controlResolver.wait(
            idKey(projectId, jobId),
            600_000,
            "Control pod",
        );
        if (response.type === PROMPT_RESPONSE) {
            await publishEnvelope(OrchestatorToBackend, {
                projectId,
                jobId,
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
            jobId,
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
