import { createClient } from "redis";
import { OrchestatorToBackend } from "types";
import { responseManager } from "./responseManager"; // adjust path

const redis = createClient({ url: process.env.REDIS_URL || "redis://localhost:6379" });

async function listenToOrchestrator() {
    console.log("Listening on stream:", OrchestatorToBackend);
    let lastId = "$";
    while (true) {
        try {
            const res = await redis.xRead(
                [{ key: OrchestatorToBackend, id: lastId }],
                { BLOCK: 0 }
            );
            if (!res) continue;

            //@ts-ignore
            const messages = res[0]!.messages;
            for (const msg of messages) {
                lastId = msg.id;
                const raw = msg.message?.data;
                if (!raw) {
                    console.warn(`[Backend] Skipping message ${msg.id} with no data field`);
                    continue;
                }

                let data: any;
                try {
                    data = JSON.parse(raw);
                } catch (parseErr) {
                    console.error(`[Backend] Failed to parse message ${msg.id}:`, parseErr);
                    continue;
                }

                const { projectId, jobId, type, payload } = data;

                // if (!projectId || !jobId) {
                //     console.warn(`[Backend] Skipping message ${msg.id}: missing projectId or jobId`, data);
                //     continue;
                // }

                console.log(`[Backend] Received from orchestrator: ${type} for project=${projectId} job=${jobId}`);

                //TODO:  Resolve the waiting promise, correlated by jobId (not just projectId)

                responseManager.resolve(projectId,  JSON.stringify({ type, payload }));
            }
        } catch (err) {
            console.error("Error in orchestrator listener:", err);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }
}

// Start the listener when the backend boots
export async function startOrchestratorListener() {
    await redis.connect();
    console.log("Redis connected for orchestrator listener");
    listenToOrchestrator();

    process.on("SIGINT", () => shutdown("SIGINT"));
    process.on("SIGTERM", () => shutdown("SIGTERM"));
}

async function shutdown(signal: string) {
    console.log(`[Backend] Received ${signal}, shutting down orchestrator listener...`);
    try {
        await redis.quit();
    } catch (err) {
        console.error("Error closing redis connection:", err);
    } finally {
        process.exit(0);
    }
}