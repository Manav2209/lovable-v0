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
            // @ts-ignore – structure is known
            const messages = res[0]!.messages;
            for (const msg of messages) {
                lastId = msg.id;
                const raw = msg.message?.data;
                if (!raw) continue;
                const data = JSON.parse(raw);
                const { projectId, type, payload } = data;
                if (!projectId) continue;
                console.log(`[Backend] Received from orchestrator: ${type} for ${projectId}`);
                // Resolve the waiting promise
                responseManager.resolve(projectId, JSON.stringify({ type, payload }));
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
}