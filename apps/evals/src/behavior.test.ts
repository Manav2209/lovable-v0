import { describe, expect, test } from "bun:test";
import { runBehaviorChecks } from "./behavior";
import type { AgentRunResult } from "./agentRun";

function result(overrides: Partial<AgentRunResult> = {}): AgentRunResult {
    return {
        runId: "r",
        caseId: "c",
        projectId: "p",
        status: "completed",
        completed: true,
        dependenciesAdded: 0,
        durationMs: 1000,
        eventsCaptured: 0,
        timestamp: 0,
        agent: { steps: 4, toolCalls: 6, durationMs: 1000 },
        react: {
            toolCallsByTool: { listFiles: 1, readFile: 2, createFile: 1 },
            readOps: 3,
            mutationOps: 1,
            buildCount: 1,
            stitchInvoked: false,
        },
        repair: { attempts: 0, maxAttempts: 2 },
        ...overrides,
    };
}

describe("runBehaviorChecks", () => {
    test("passes inspect-before-edit when reads happened", () => {
        const inspect = runBehaviorChecks(result()).find((c) => c.id === "inspect-before-edit")!;
        expect(inspect.passed).toBe(true);
        expect(inspect.diagnostic).toBe(true);
    });

    test("fails inspect-before-edit when mutating with zero reads", () => {
        const inspect = runBehaviorChecks(
            result({
                react: {
                    toolCallsByTool: { createFile: 2 },
                    readOps: 0,
                    mutationOps: 2,
                    buildCount: 1,
                    stitchInvoked: false,
                },
            }),
        ).find((c) => c.id === "inspect-before-edit")!;
        expect(inspect.passed).toBe(false);
    });

    test("no-stitch-happy-path fails when stitch ran on a completed build", () => {
        const stitch = runBehaviorChecks(
            result({
                react: {
                    toolCallsByTool: { readFile: 1 },
                    readOps: 1,
                    mutationOps: 0,
                    buildCount: 1,
                    stitchInvoked: true,
                },
            }),
        ).find((c) => c.id === "no-stitch-happy-path")!;
        expect(stitch.passed).toBe(false);
    });
});
