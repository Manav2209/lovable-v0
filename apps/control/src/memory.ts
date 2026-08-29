import { RedisManager } from "shared-redis";

/**
 * Durable per-project memory. Backed by Redis so project context survives
 * control pod restarts. Degrades to an in-process Map when Redis is
 * unavailable or during eval runs, so harnesses never need Redis.
 */

const MEMORY_PREFIX = "lovable:memory";

function memoryKey(projectId: string, key: string): string {
    return `${MEMORY_PREFIX}:${projectId}:${key}`;
}

const fallbackStore = new Map<string, unknown>();

function isEval(): boolean {
    return process.env.EVAL_MODE === "1";
}

function sortByTimestamp(items: any[]): any[] {
    const toMs = (v: any): number => {
        const raw = v?.timestamp;
        if (typeof raw === "number") return raw;
        if (typeof raw === "string") return new Date(raw).getTime() || 0;
        return 0;
    };
    return items
        .filter((v) => v !== null)
        .sort((a, b) => toMs(a) - toMs(b));
}

export async function getProjectMemories(projectId: string): Promise<any[]> {
    try {
        if (isEval()) {
            const prefix = memoryKey(projectId, "");
            return sortByTimestamp(
                [...fallbackStore.entries()]
                    .filter(([k]) => k.startsWith(prefix))
                    .map(([, v]) => v),
            );
        }

        const client = await RedisManager.getWriter();
        const keys: string[] = [];
        for await (const batch of client.scanIterator({
            MATCH: memoryKey(projectId, "*"),
            COUNT: 100,
        })) {
            keys.push(...batch);
        }
        if (keys.length === 0) return [];

        const values = await client.mGet(keys);
        return sortByTimestamp(
            (values ?? [])
                .filter((v): v is string => Boolean(v))
                .map((v) => {
                    try {
                        return JSON.parse(v);
                    } catch {
                        return null;
                    }
                }),
        );
    } catch (error) {
        console.error("Error retrieving memories:", error);
        return [];
    }
}

export async function saveProjectMemory(
    projectId: string,
    key: string,
    value: any,
): Promise<void> {
    try {
        if (isEval()) {
            fallbackStore.set(memoryKey(projectId, key), value);
            return;
        }

        const client = await RedisManager.getWriter();
        await client.set(memoryKey(projectId, key), JSON.stringify(value));
    } catch (error) {
        console.error("Error saving memory:", error);
    }
}

export async function saveConversationMemory(
    projectId: string,
    prompt: string,
    response: string,
): Promise<void> {
    const key = `conversation_${Date.now()}`;
    const value = {
        timestamp: Date.now(),
        prompt,
        response,
        type: "conversation",
    };
    await saveProjectMemory(projectId, key, value);
}