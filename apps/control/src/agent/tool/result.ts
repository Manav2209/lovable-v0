import { createHash } from "node:crypto";

export type ToolResult = {
    success: boolean;
    message: string;
    data?: unknown;
    diagnostics?: { path?: string; line?: number; column?: number };
    changedFiles?: string[];
};

export function toolOk(
    message: string,
    extra: Partial<Omit<ToolResult, "success" | "message">> = {},
): ToolResult {
    return { success: true, message, ...extra };
}

export function toolFail(
    message: string,
    extra: Partial<Omit<ToolResult, "success" | "message">> = {},
): ToolResult {
    return { success: false, message, ...extra };
}

export function contentHash(content: string): string {
    return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
}

/** Keep tool output valid JSON, including the hash needed for the next edit. */
export function serializeToolResult(result: unknown, limit: number): string {
    const raw = JSON.stringify(result) ?? "null";
    if (raw.length <= limit) return raw;
    const record = result && typeof result === "object" ? result as Record<string, unknown> : {};
    const data = record.data as Record<string, unknown> | undefined;
    if (data && typeof data.content === "string") {
        let low = 0;
        let high = data.content.length;
        let best = JSON.stringify({ ...record, data: { ...data, content: "", truncated: true } });
        if (best.length <= limit) {
            while (low <= high) {
                const middle = Math.floor((low + high) / 2);
                const candidate = JSON.stringify({ ...record, data: { ...data, content: data.content.slice(0, middle), truncated: true } });
                if (candidate.length <= limit) { best = candidate; low = middle + 1; }
                else high = middle - 1;
            }
            return best;
        }
    }
    return JSON.stringify({
        success: record.success, message: String(record.message ?? "").slice(0, 500),
        hash: data?.hash, truncated: true,
        note: "Output exceeded the message budget; retrieve a smaller range or more specific search.",
    });
}

export function countOccurrences(haystack: string, needle: string): number {
    if (!needle) return 0;
    let count = 0;
    let idx = 0;
    while ((idx = haystack.indexOf(needle, idx)) !== -1) {
        count += 1;
        idx += needle.length;
    }
    return count;
}
