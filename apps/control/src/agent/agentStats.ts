export const READ_TOOL_NAMES = new Set([
    "listFiles",
    "searchFiles",
    "readFile",
    "listDir",
    "grepSearch",
]);

export const MUTATION_TOOL_NAMES = new Set([
    "createFile",
    "updateFile",
    "patchFile",
    "replaceInFile",
    "deleteFile",
    "writeMultipleFile",
    "lineReplace",
    "addDependency",
    "removeDependency",
    "addShadcnComponent",
    "renameFile",
]);

export type AgentStats = {
    steps: number;
    toolCalls: number;
    toolCallsByTool: Record<string, number>;
    readOps: number;
    mutationOps: number;
    timeToFirstToolMs?: number;
    stitchInvoked: boolean;
    buildCount: number;
};

export function emptyAgentStats(): AgentStats {
    return {
        steps: 0,
        toolCalls: 0,
        toolCallsByTool: {},
        readOps: 0,
        mutationOps: 0,
        stitchInvoked: false,
        buildCount: 0,
    };
}

export function mergeAgentStats(a: AgentStats, b: Partial<AgentStats>): AgentStats {
    const toolCallsByTool = { ...a.toolCallsByTool };
    for (const [name, count] of Object.entries(b.toolCallsByTool ?? {})) {
        toolCallsByTool[name] = (toolCallsByTool[name] ?? 0) + count;
    }
    return {
        steps: a.steps + (b.steps ?? 0),
        toolCalls: a.toolCalls + (b.toolCalls ?? 0),
        toolCallsByTool,
        readOps: a.readOps + (b.readOps ?? 0),
        mutationOps: a.mutationOps + (b.mutationOps ?? 0),
        timeToFirstToolMs: a.timeToFirstToolMs ?? b.timeToFirstToolMs,
        stitchInvoked: a.stitchInvoked || Boolean(b.stitchInvoked),
        buildCount: a.buildCount + (b.buildCount ?? 0),
    };
}

export function recordToolUse(
    stats: AgentStats,
    toolName: string,
    elapsedMs: number,
): void {
    stats.toolCalls += 1;
    stats.toolCallsByTool[toolName] = (stats.toolCallsByTool[toolName] ?? 0) + 1;
    if (READ_TOOL_NAMES.has(toolName)) stats.readOps += 1;
    if (MUTATION_TOOL_NAMES.has(toolName)) stats.mutationOps += 1;
    if (toolName === "stitchApp") stats.stitchInvoked = true;
    if (stats.timeToFirstToolMs === undefined) stats.timeToFirstToolMs = elapsedMs;
}
