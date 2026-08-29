import {
    ControlToServing,
    OrchestatorToServing,
    ServingToControl,
    PROJECT_INITIALIZED,
    PROJECT_RUN,
    ServingToOrchestrator,
    PROJECT_CREATED,
    PROJECT_FAILED,
    PROJECT_RUN_SUCCESS,
    PROJECT_RUN_FAILED,
    PreviewRegister,
    PREVIEW_REGISTER,
    buildPreviewUrl,
    toPreviewSlug,
    agentSseChannel,
} from "types";
import fs from "fs";
import { checkIfProjectFilesExist, serveTheProject, projectDir as projectDirFor } from "./lib/helper";
import {
    RedisManager,
    publishEnvelope,
    parseStreamFields,
    readGroupLoop,
    StreamGroups,
} from "shared-redis";

console.log("Serving POD started with env:", {
    NODE_ENV: process.env.NODE_ENV,
    PROJECT_ID: process.env.PROJECT_ID,
    BUCKET_NAME: process.env.BUCKET_NAME,
    REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
    SHARED_DIR: process.env.SHARED_DIR || "/app/shared",
    PREVIEW_DOMAIN: process.env.PREVIEW_DOMAIN || "preview.localhost",
});

export let projectRunning = false;

function resolveUpstream(): string {
    if (process.env.PREVIEW_UPSTREAM) {
        return process.env.PREVIEW_UPSTREAM.replace(/\/$/, "");
    }
    const port = process.env.PORT || "3000";
    return `http://127.0.0.1:${port}`;
}

async function registerPreview(projectId: string, upstream: string) {
    const slug = toPreviewSlug(projectId);
    const ingressAdmin =
        process.env.INGRESS_ADMIN_URL || "http://127.0.0.1:8080";

    try {
        await publishEnvelope(PreviewRegister, {
            type: PREVIEW_REGISTER,
            projectId,
            slug,
            payload: upstream,
        });
    } catch (err) {
        console.warn(`[${projectId}] Redis preview register failed:`, err);
    }

    try {
        const res = await fetch(`${ingressAdmin}/_ingress/register`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ projectId, slug, upstream }),
        });
        if (!res.ok) {
            console.warn(
                `[${projectId}] HTTP preview register failed:`,
                await res.text(),
            );
        }
    } catch (err) {
        console.warn(
            `[${projectId}] Ingress admin unreachable at ${ingressAdmin}:`,
            err,
        );
    }
}

async function handleRunProject(projectId: string) {
    try {
        console.log(`[${projectId}] Attempting to serve project`);
        if (!checkIfProjectFilesExist(projectId)) {
            throw new Error("Project files missing");
        }
        const ok = await serveTheProject(projectId);
        if (!ok) {
            throw new Error("Failed to start project server");
        }
        console.log(`[${projectId}] Project is now running`);
        projectRunning = true;

        const upstream = resolveUpstream();
        await registerPreview(projectId, upstream);

        const previewUrl =
            process.env.PREVIEW_URL || buildPreviewUrl({ projectId });

        await publishEnvelope(ServingToOrchestrator, {
            type: PROJECT_RUN_SUCCESS,
            projectId,
            payload: previewUrl,
        });
        console.log(
            `[${projectId}] Sent PROJECT_RUN_SUCCESS url=${previewUrl}`,
        );

        try {
            const redis = await RedisManager.getWriter();
            await redis.publish(
                agentSseChannel(projectId),
                JSON.stringify({
                    type: "preview_ready",
                    message: "Preview is ready",
                    url: previewUrl,
                }),
            );
        } catch (err) {
            console.warn(`[${projectId}] Failed to publish preview_ready SSE:`, err);
        }
    } catch (error) {
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        console.error(`[${projectId}] Run failed:`, errorMessage);

        await publishEnvelope(ServingToOrchestrator, {
            type: PROJECT_RUN_FAILED,
            projectId,
            payload: errorMessage,
        });
        console.log(`[${projectId}] Sent PROJECT_RUN_FAILED to orchestrator`);
    }
}

const MY_PROJECT_ID = process.env.PROJECT_ID || "";

async function ListenControl() {
    const group = MY_PROJECT_ID
        ? `${StreamGroups.serve}-${MY_PROJECT_ID}`
        : StreamGroups.serve;

    await readGroupLoop({
        stream: ControlToServing,
        group,
        readerRole: "serveControl",
        handler: async (_id, fields) => {
            const msgFromControl = parseStreamFields(fields);
            const projectId = msgFromControl.projectId as string | undefined;
            const type = msgFromControl.type;

            if (!projectId) {
                console.warn("Control message missing projectId");
                return;
            }

            if (MY_PROJECT_ID && projectId !== MY_PROJECT_ID) {
                return;
            }

            console.log(`[${projectId}] Received from control: ${type}`);

            switch (type) {
                case PROJECT_INITIALIZED:
                    try {
                        console.log(`[${projectId}] Initialization started`);
                        const projectDir = projectDirFor(projectId);

                        if (!fs.existsSync(projectDir)) {
                            throw new Error("project workspace not found");
                        }

                        const files = fs.readdirSync(projectDir);
                        if (files.length === 0) {
                            throw new Error("project workspace is empty");
                        }

                        await publishEnvelope(ServingToControl, {
                            type: PROJECT_INITIALIZED,
                            success: "true",
                            projectId,
                        });

                        await publishEnvelope(ServingToOrchestrator, {
                            type: PROJECT_CREATED,
                            projectId,
                            success: "true",
                        });
                        console.log(
                            `[${projectId}] PROJECT_CREATED sent to Orchestrator`,
                        );
                    } catch (error) {
                        const errorMessage =
                            error instanceof Error
                                ? error.message
                                : String(error);

                        await publishEnvelope(ServingToControl, {
                            type: PROJECT_INITIALIZED,
                            success: "false",
                            payload: errorMessage,
                            projectId,
                        });

                        await publishEnvelope(ServingToOrchestrator, {
                            type: PROJECT_FAILED,
                            projectId,
                            payload: errorMessage,
                        });
                    }
                    break;

                case PROJECT_RUN:
                    await handleRunProject(projectId);
                    break;

                default:
                    console.log(
                        `Received unknown message: ${type} for project: ${projectId} from control pod`,
                    );
                    break;
            }
        },
    });
}

async function ListenOrchestator() {
    const group = MY_PROJECT_ID
        ? `${StreamGroups.serve}-${MY_PROJECT_ID}`
        : StreamGroups.serve;

    await readGroupLoop({
        stream: OrchestatorToServing,
        group,
        readerRole: "serveOrch",
        handler: async (_id, fields) => {
            const msgFromOrch = parseStreamFields(fields);
            const { projectId, type } = msgFromOrch;

            if (!projectId) {
                console.warn("Orchestrator message missing projectId");
                return;
            }

            if (MY_PROJECT_ID && projectId !== MY_PROJECT_ID) {
                return;
            }

            console.log(
                `[${projectId}] Received from orchestrator: ${type}`,
            );

            switch (type) {
                case PROJECT_RUN:
                    await handleRunProject(projectId as string);
                    break;
                default:
                    console.log(
                        `Received unknown message: ${type} for project: ${projectId} from orchestrator`,
                    );
            }
        },
    });
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
    console.log("Serving POD Started");

    void ListenControl();
    void ListenOrchestator();
    await new Promise(() => {});
}

main().catch((error) => {
    console.error("Fatal error in Serving POD:", error);
    process.exit(1);
});
