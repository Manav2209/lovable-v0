import "dotenv/config";
import {
    OrchestatorToControl,
    ControlToServing,
    ServingToControl,
    PROJECT_INITIALIZED,
    PROJECT_BUILD,
    PROMPT,
    ServingToOrchestrator,
    PROJECT_FAILED,
    PROJECT_BUILD_FAILED,
    PROJECT_BUILD_SUCCESS,
    ControlToOrchestrator,
    assertSafeProjectId,
} from "types";
import { listObjects, getObject } from "r2";
import fs from "fs";
import path from "path";
import { buildProjectAndNotifyToRun } from "./agent/tool/code/buildSource";
import { resolveSafePath } from "./agent/tool/security";
import { processPrompt } from "./agent";
import { startSSEServer } from "./sse";
import {
    RedisManager,
    publishEnvelope,
    parseStreamFields,
    readGroupLoop,
    StreamGroups,
} from "shared-redis";

const bucketName = process.env.BUCKET_NAME || "lovable";

console.log("Control POD started with env:", {
    NODE_ENV: process.env.NODE_ENV,
    PROJECT_ID: process.env.PROJECT_ID,
    BUCKET_NAME: process.env.BUCKET_NAME,
    REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
    SHARED_DIR: process.env.SHARED_DIR || "/app/shared",
    GROQ_API_KEY: process.env.GROQ_API_KEY ? "***" : undefined,
});

const processing = new Map<
    string,
    (value: { success: string; payload?: string }) => void
>();

function waitForServingConfirmation(projectId: string, timeoutMs = 60_000) {
    return new Promise<{ success: string; payload?: string }>(
        (resolve, reject) => {
            const timer = setTimeout(() => {
                processing.delete(projectId);
                reject(new Error("Serving pod timeout"));
            }, timeoutMs);

            processing.set(projectId, (value) => {
                clearTimeout(timer);
                resolve(value);
            });
        },
    );
}

async function pullTemplatefromR2(projectId: string) {
    try {
        assertSafeProjectId(projectId);
        const { Contents } = await listObjects({
            Bucket: bucketName,
            Prefix: "template/",
        });

        if (!Contents || Contents.length === 0) {
            throw new Error("No template files found in bucket");
        }

        const sharedDir = process.env.SHARED_DIR || "/app/shared";
        const projectDir = resolveSafePath(sharedDir, projectId);

        if (!fs.existsSync(sharedDir)) {
            fs.mkdirSync(sharedDir, { recursive: true });
        }
        fs.mkdirSync(projectDir, { recursive: true });

        for (const obj of Contents) {
            if (!obj.Key) continue;
            if (obj.Key === "template/") continue;
            const relativePath = obj.Key.replace("template/", "");
            try {
                const { Body } = await getObject({
                    Bucket: bucketName,
                    Key: obj.Key,
                });
                const filePath = resolveSafePath(projectDir, relativePath);
                const fileDir = path.dirname(filePath);
                if (!fs.existsSync(fileDir)) {
                    fs.mkdirSync(fileDir, { recursive: true });
                }
                const buffer = Buffer.from(
                    (await Body?.transformToByteArray()) || new Uint8Array(),
                );
                fs.writeFileSync(filePath, buffer);
                console.log(`[${projectId}] Downloaded: ${relativePath}`);
            } catch (error) {
                console.error(`Failed to download ${obj.Key}:`, error);
            }
        }

        console.log(
            `[${projectId}] Template pull completed (${Contents.length} files processed)`,
        );
        return true;
    } catch (error) {
        console.error("Error in pullTemplatefromR2:", error);
        return false;
    }
}

const MY_PROJECT_ID = process.env.PROJECT_ID || "";

async function ListenOrchestator() {
    // Per-project consumer group so other project pods cannot steal our messages.
    const group = MY_PROJECT_ID
        ? `${StreamGroups.control}-${MY_PROJECT_ID}`
        : StreamGroups.control;

    await readGroupLoop({
        stream: OrchestatorToControl,
        group,
        readerRole: "controlOrch",
        handler: async (_id, fields) => {
            const parsed = parseStreamFields(fields);
            console.log("Message:", parsed);
            const type = parsed.type;
            const projectId = parsed.projectId as string | undefined;
            const jobId = parsed.jobId as string | undefined;
            if (!projectId) {
                console.log("Missing projectId");
                return;
            }

            if (MY_PROJECT_ID && projectId !== MY_PROJECT_ID) {
                return;
            }

            if (processing.has(projectId) && type === PROJECT_INITIALIZED) {
                console.log(
                    `Project ${projectId} is already being processed, skipping`,
                );
                return;
            }

            switch (type) {
                case PROJECT_INITIALIZED:
                    try {
                        const ok = await pullTemplatefromR2(projectId);
                        if (!ok) {
                            throw new Error("template pull failed");
                        }
                        console.log("template pull completed");

                        await publishEnvelope(ControlToServing, {
                            projectId,
                            type: PROJECT_INITIALIZED,
                            jobId,
                        });

                        const result =
                            await waitForServingConfirmation(projectId);

                        if (result.success !== "true") {
                            throw new Error(result.payload || "Serving failed");
                        }
                        console.log(`[${projectId}] initialization done`);
                    } catch (e) {
                        console.error(
                            `[${projectId}] initialization failed`,
                            e,
                        );
                        await publishEnvelope(ServingToOrchestrator, {
                            type: PROJECT_FAILED,
                            projectId,
                            payload: String(e),
                        });
                        processing.delete(projectId);
                    }
                    break;

                case PROJECT_BUILD:
                    try {
                        const buildResultSuccess =
                            await buildProjectAndNotifyToRun(projectId, jobId);
                        const responseType = buildResultSuccess
                            ? PROJECT_BUILD_SUCCESS
                            : PROJECT_BUILD_FAILED;

                        await publishEnvelope(ControlToOrchestrator, {
                            projectId,
                            type: responseType,
                            jobId,
                            success: buildResultSuccess ? "true" : "false",
                            payload: buildResultSuccess ? "" : "Build failed",
                        });
                        console.log(
                            `[${projectId}] Build result (${responseType}) sent to orchestrator`,
                        );
                    } catch (error) {
                        console.error(`[${projectId}] Build error:`, error);
                        await publishEnvelope(ControlToOrchestrator, {
                            projectId,
                            type: PROJECT_BUILD_FAILED,
                            jobId,
                            success: "false",
                            payload: String(error),
                        });
                    }
                    break;

                case PROMPT: {
                    const prompt = parsed.payload;
                    if (!prompt || typeof prompt !== "string") {
                        console.log("Prompt missing payload");
                        break;
                    }
                    try {
                        await processPrompt(projectId, jobId, prompt);
                    } catch (err) {
                        console.error("Prompt failed", err);
                    }
                    break;
                }

                default:
                    console.log("Unknown type:", type);
                    break;
            }
        },
    });
}

async function ListenServing() {
    const group = MY_PROJECT_ID
        ? `${StreamGroups.control}-${MY_PROJECT_ID}`
        : StreamGroups.control;

    await readGroupLoop({
        stream: ServingToControl,
        group,
        readerRole: "controlServing",
        handler: async (_id, fields) => {
            const streamMsg = parseStreamFields(fields);
            const { type, projectId, success, payload } = streamMsg;
            if (!projectId) return;

            if (MY_PROJECT_ID && projectId !== MY_PROJECT_ID) {
                return;
            }

            const resolver = processing.get(projectId as string);
            if (resolver && type === PROJECT_INITIALIZED) {
                resolver({
                    success: (success as string) || "false",
                    payload:
                        typeof payload === "string" ? payload : undefined,
                });
                processing.delete(projectId as string);
            } else {
                console.log(
                    `Received unknown message: ${type} for project ${projectId} from SERVING_TO_CONTROL`,
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
    console.log("redis connected");
    console.log("Control Pod is Running");

    // Start stream listeners first so the per-project group exists before
    // readiness passes and the orchestrator sends PROJECT_INITIALIZED.
    void ListenOrchestator();
    void ListenServing();
    await new Promise((r) => setTimeout(r, 1500));
    startSSEServer();

    // Keep process alive
    await new Promise(() => {});
}

main().catch((error) => {
    console.error("Fatal error in Control POD:", error);
    process.exit(1);
});
