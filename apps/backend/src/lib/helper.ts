import { GoogleGenerativeAI } from "@google/generative-ai";
import { RedisManager, publishEnvelope } from "shared-redis";
import type { StreamEnvelope } from "shared-redis";
import { agentSseChannel } from "types";
import { randomUUID } from "node:crypto";

/** Publish a typed envelope onto a Redis stream. */
export async function publishToStream(
    stream: string,
    envelope: StreamEnvelope,
) {
    return publishEnvelope(stream, envelope);
}

/** Progress delivery must not turn an accepted job into an HTTP failure. */
export async function publishProjectProgress(projectId: string, event: { type: string; message: string; jobId: string }) {
    try {
        const redis = await RedisManager.getWriter();
        await redis.publish(agentSseChannel(projectId), JSON.stringify(event));
    } catch (error) {
        console.error(`[progress] Failed to publish ${event.type} for ${projectId}:`, error);
    }
}

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

export async function createTitle(initialPrompt: string): Promise<string> {
    const prompt = `Create a concise, catchy title for this content just one : ${initialPrompt}`;
    const result = await model.generateContent(prompt);
    const response = await result.response;
    return response.text();
}

export function createRandomJobId() {
    return randomUUID();
}
