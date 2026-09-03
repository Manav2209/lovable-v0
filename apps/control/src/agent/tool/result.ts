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
