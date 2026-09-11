import { RedisManager } from "shared-redis";

/**
 * Durable per-project memory. Backed by Redis so project context survives
 * control pod restarts. Degrades to an in-process Map when Redis is
 * unavailable or during eval runs, so harnesses never need Redis.
 */

const MEMORY_PREFIX = "lovable:memory";
/** Memory entries expire after 30 days so Redis keys never grow unbounded. */
const MEMORY_TTL_SECONDS = 60 * 60 * 24 * 30;
/** Cap on the number of memory entries handed back to consumers. */
const MEMORY_MAX_ENTRIES = 20;

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
            ).slice(-MEMORY_MAX_ENTRIES);
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
        const sorted = sortByTimestamp(
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
        return sorted.slice(-MEMORY_MAX_ENTRIES);
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
        await client.set(
            memoryKey(projectId, key),
            JSON.stringify(value),
            { EX: MEMORY_TTL_SECONDS },
        );
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

export interface ChangeSummaryRecord {
    filesCreated?: string[];
    filesModified?: string[];
    filesDeleted?: string[];
    commandsExecuted?: string[];
    dependenciesAdded?: string[];
    dependenciesRemoved?: string[];
    buildStatus?: string;
    summary?: string;
}

/**
 * Persist the structured change summary of a completed turn so the next turn
 * can act on what the agent actually changed (files, deps, build status)
 * instead of only free-text conversation.
 */
export async function saveChangeSummary(
    projectId: string,
    prompt: string,
    changeSummary: ChangeSummaryRecord | null | undefined,
): Promise<void> {
    const key = `change_${Date.now()}`;
    const value = {
        timestamp: Date.now(),
        prompt,
        type: "change_summary",
        changeSummary: changeSummary ?? null,
    };
    await saveProjectMemory(projectId, key, value);
}

/**
 * Render prior memory entries as a compact, actionable plain-text block for the
 * intent planner. Purely formatting — never throws on malformed entries.
 */
export function renderPriorContext(previousContext: unknown, maxChars = 2000): string {
    if (!Array.isArray(previousContext) || previousContext.length === 0) return "";
    const quote = (v: unknown, len: number): string => `"${String(v ?? "").slice(0, len)}"`;
    const list = (v: unknown): string => {
        const arr = Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
        return arr.length ? `[${arr.join(", ")}]` : "[]";
    };

    const lines: string[] = [];
    for (const raw of previousContext) {
        if (!raw || typeof raw !== "object") continue;
        const entry = raw as Record<string, unknown>;
        if (entry.type === "change_summary") {
            const cs = (entry.changeSummary ?? {}) as Record<string, unknown>;
            lines.push(
                `- Prior turn: Request ${quote(entry.prompt, 160)} — ${quote(cs.summary, 200)} ` +
                    `(created ${list(cs.filesCreated)}, modified ${list(cs.filesModified)}, ` +
                    `deleted ${list(cs.filesDeleted)}, deps +${list(cs.dependenciesAdded)} -${list(cs.dependenciesRemoved)}, ` +
                    `build ${String(cs.buildStatus ?? "unknown")})`,
            );
        } else {
            lines.push(
                `- Prior turn: ${quote(entry.prompt, 200)} -> ${quote(entry.response, 200)}`,
            );
        }
    }

    let out = lines.join("\n");
    if (out.length > maxChars) {
        out = out.slice(0, maxChars) + "\n...(truncated)";
    }
    return out;
}