import { GoogleGenerativeAI } from "@google/generative-ai";
import { RedisManager, publishEnvelope } from "shared-redis";
import type { StreamEnvelope } from "shared-redis";
import { randomUUID } from "node:crypto";

/** Publish a typed envelope onto a Redis stream. */
export async function publishToStream(
    stream: string,
    envelope: StreamEnvelope,
) {
    return publishEnvelope(stream, envelope);
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
