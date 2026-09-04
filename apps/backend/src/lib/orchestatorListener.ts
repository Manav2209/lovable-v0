import {
    RedisManager,
    parseStreamFields,
    readGroupLoop,
    StreamGroups,
} from "shared-redis";
import { OrchestatorToBackend } from "types";
import { responseManager } from "./responseManager";

async function listenToOrchestrator() {
    await readGroupLoop({
        stream: OrchestatorToBackend,
        group: StreamGroups.backend,
        readerRole: "backendOrch",
        handler: async (_id, fields) => {
            const data = parseStreamFields(fields);
            const { projectId, jobId, type, payload } = data;

            console.log(
                `[Backend] Received from orchestrator: ${type} for project=${projectId} job=${jobId}`,
            );

            if (!projectId) {
                console.warn(
                    `[Backend] Skipping message: missing projectId`,
                    data,
                );
                return;
            }

            // Resolve the waiting promise correlated by jobId (not projectId),
            // so concurrent build/prompt/run requests for the same project
            // each get their own response (spec-06 §1). Fall back to projectId
            // only if the orchestrator didn't echo a jobId.
            const key = (jobId as string | undefined) || (projectId as string);
            responseManager.resolve(
                key,
                JSON.stringify({ type, payload }),
            );
        },
    });
}

export async function startOrchestratorListener() {
    await RedisManager.getWriter();
    console.log("Redis connected for orchestrator listener");
    // Fire-and-forget; loop never resolves
    listenToOrchestrator().catch((err) => {
        console.error("Orchestrator listener crashed:", err);
    });

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function shutdown(signal: string) {
    console.log(
        `[Backend] Received ${signal}, shutting down orchestrator listener...`,
    );
    try {
        await RedisManager.quitAll();
    } catch (err) {
        console.error("Error closing redis connection:", err);
    } finally {
        process.exit(0);
    }
}
