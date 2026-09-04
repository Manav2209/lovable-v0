import type { AgentRunResult, EvaluationDimensions } from "./agentRun";
import { MUTATION_TOOL_NAMES, READ_TOOL_NAMES } from "@control/agent/agentStats";

export type BehaviorCheckId =
    | "inspect-before-edit"
    | "no-stitch-happy-path"
    | "bounded-agent"
    | "single-validation-build"
    | "reactive-tool-usage";

export interface BehaviorCheck {
    id: BehaviorCheckId;
    passed: boolean;
    diagnostic: boolean;
    detail: string;
}

const MAX_STEPS = Number(process.env.MAX_AGENT_STEPS || 20);
const MAX_TOOL_CALLS = Number(process.env.MAX_TOOL_CALLS || 40);

export function runBehaviorChecks(result: AgentRunResult): BehaviorCheck[] {
    const react = result.react;
    const tools = react?.toolCallsByTool ?? {};
    const names = Object.keys(tools);
    const readBeforeEdit = (() => {
        if (!react) return false;
        if (react.mutationOps === 0) return true;
        return (react.readOps ?? 0) > 0;
    })();

    const inspect: BehaviorCheck = {
        id: "inspect-before-edit",
        diagnostic: true,
        passed: readBeforeEdit,
        detail: readBeforeEdit
            ? `reads=${react?.readOps ?? 0} mutations=${react?.mutationOps ?? 0}`
            : "mutated files without any list/search/read",
    };

    const stitchOk =
        result.status !== "completed" || react?.stitchInvoked !== true;
    const stitch: BehaviorCheck = {
        id: "no-stitch-happy-path",
        diagnostic: true,
        passed: stitchOk,
        detail: react?.stitchInvoked
            ? "stitchApp ran on this generation"
            : "stitchApp not used",
    };

    const bounded =
        (result.agent?.steps ?? 0) <= MAX_STEPS &&
        (result.agent?.toolCalls ?? 0) <= MAX_TOOL_CALLS &&
        !String(result.error || "").includes("Exceeded MAX_");
    const bound: BehaviorCheck = {
        id: "bounded-agent",
        diagnostic: true,
        passed: bounded,
        detail: `steps=${result.agent?.steps ?? 0}/${MAX_STEPS} tools=${result.agent?.toolCalls ?? 0}/${MAX_TOOL_CALLS}`,
    };

    const builds = react?.buildCount ?? 0;
    const buildCheck: BehaviorCheck = {
        id: "single-validation-build",
        diagnostic: true,
        passed: result.status !== "completed" || builds <= 1 + (result.repair?.attempts ?? 0),
        detail: `buildCount=${builds} repairAttempts=${result.repair?.attempts ?? 0}`,
    };

    const usedRetrieval = names.some((n) => READ_TOOL_NAMES.has(n));
    const usedMutation = names.some((n) => MUTATION_TOOL_NAMES.has(n));
    const reactive = (result.agent?.steps ?? 0) >= 2 && (usedRetrieval || usedMutation);
    const reactCheck: BehaviorCheck = {
        id: "reactive-tool-usage",
        diagnostic: true,
        passed: result.status !== "completed" || reactive,
        detail: `steps=${result.agent?.steps ?? 0} retrieval=${usedRetrieval} mutation=${usedMutation}`,
    };

    return [inspect, stitch, bound, buildCheck, reactCheck];
}

export function evaluationDimensions(
    result: AgentRunResult,
    checksPassed?: boolean,
    judgeValid?: boolean,
    checksRan?: boolean,
    judgeRan?: boolean,
): EvaluationDimensions {
    return {
        executionStatus: result.status,
        buildStatus: result.build?.status ?? "not_run",
        checksStatus: !checksRan ? "skipped" : checksPassed ? "passed" : "failed",
        judgeStatus: !judgeRan ? "skipped" : judgeValid ? "valid" : "invalid",
    };
}

export function deriveRunMetrics(results: AgentRunResult[]): {
    toolCallsPerSuccess: number;
    readsBeforeFirstEditHint: number;
    editsPerSuccess: number;
    buildsPerCase: number;
    repairRate: number;
} {
    const successes = results.filter((r) => r.status === "completed");
    const n = Math.max(results.length, 1);
    const successN = Math.max(successes.length, 1);
    const toolCalls = successes.reduce((a, r) => a + (r.agent?.toolCalls ?? 0), 0);
    const edits = successes.reduce((a, r) => a + (r.files?.modified ?? 0) + (r.files?.created ?? 0), 0);
    const builds = results.reduce((a, r) => a + (r.react?.buildCount ?? 0), 0);
    const repaired = results.filter((r) => (r.repair?.attempts ?? 0) > 0).length;
    const reads = successes.reduce((a, r) => a + (r.react?.readOps ?? 0), 0);
    return {
        toolCallsPerSuccess: toolCalls / successN,
        readsBeforeFirstEditHint: reads / successN,
        editsPerSuccess: edits / successN,
        buildsPerCase: builds / n,
        repairRate: repaired / n,
    };
}
