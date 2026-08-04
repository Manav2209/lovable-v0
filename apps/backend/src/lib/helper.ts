import { GoogleGenerativeAI } from "@google/generative-ai";
import { RedisManager, publishEnvelope } from "shared-redis";
import type { StreamEnvelope } from "shared-redis";

/** Shared Redis writer — used by routes/controllers to publish stream messages. */
export async function getRedisWriter() {
    return RedisManager.getWriter();
}

/** Publish a typed envelope onto a Redis stream. */
export async function publishToStream(
    stream: string,
    envelope: StreamEnvelope,
) {
    return publishEnvelope(stream, envelope);
}

/** @deprecated Prefer publishToStream; kept for gradual migration. */
export const redis = {
    async xAdd(
        stream: string,
        _id: string,
        fields: Record<string, string>,
    ) {
        const writer = await RedisManager.getWriter();
        // Normalize legacy flat type/payload into data envelope when possible
        if (fields.data) {
            return writer.xAdd(stream, "*", fields);
        }
        if (fields.type && fields.payload) {
            let payload: unknown = fields.payload;
            try {
                payload = JSON.parse(fields.payload);
            } catch {
                /* keep string */
            }
            const envelope: StreamEnvelope =
                typeof payload === "object" && payload !== null
                    ? {
                          type: fields.type,
                          ...(payload as Record<string, unknown>),
                      }
                    : { type: fields.type, payload };
            return publishEnvelope(stream, envelope);
        }
        return writer.xAdd(stream, "*", fields);
    },
};

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY!);
const model = genAI.getGenerativeModel({ model: "gemini-2.5-flash" });

export async function createTitle(initialPrompt: string): Promise<string> {
    const prompt = `Create a concise, catchy title for this content just one : ${initialPrompt}`;
    const result = await model.generateContent(prompt);
    console.log(result);
    const response = await result.response;
    console.log(response);
    return response.text();
}

export function createRandomJobId() {
    return Math.random().toString() + Math.random().toString();
}
