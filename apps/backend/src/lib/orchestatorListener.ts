import {
    RedisManager,
    parseStreamFields,
    readGroupLoop,
    StreamGroups,
    ensureConsumerGroup,
} from "shared-redis";
import { OrchestatorToBackend } from "types";
import { responseManager } from "./responseManager";

async function listenToOrchestrator() {
    await readGroupLoop({
        stream: OrchestatorToBackend,
        group: StreamGroups.backend,
        readerRole: "backendOrch",
        startId: "0",
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
            await responseManager.resolve(
                key,
                JSON.stringify({ type, payload }),
            );
        },
    });
}

export async function startOrchestratorListener() {
    await RedisManager.getWriter();
    await ensureConsumerGroup(OrchestatorToBackend, StreamGroups.backend, "0");
    console.log("Redis connected for orchestrator listener");
    // Fire-and-forget; loop never resolves
    listenToOrchestrator().catch((err) => {
        console.error("Orchestrator listener crashed:", err);
    });

}
