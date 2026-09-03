export type AgentRunStatus =
    | "completed"
    | "build_failed"
    | "agent_error"
    | "timeout"
    | "crashed";

export type BuildRunStatus = "passed" | "failed" | "not_run";

export type AgentRunResult = {
    runId: string;
    caseId: string;
    projectId: string;
    /** Present for reporting; not part of the agent contract. */
    tier?: string;

    status: AgentRunStatus;
    completed: boolean;

    build?: { status: BuildRunStatus; diagnostics?: string };
    repair?: { attempts: number; maxAttempts: number };
    agent?: { steps: number; toolCalls: number; durationMs: number };
    files?: { created: number; modified: number; deleted: number };

    dependenciesAdded: number;

    error?: string;
    timestamp: number;

    /** Reserved for Spec 3 (Langfuse). */
    traceId?: string;

    durationMs: number;
    eventsCaptured: number;
    maxFixAttempts?: number;

    react?: {
        toolCallsByTool: Record<string, number>;
        readOps: number;
        mutationOps: number;
        buildCount: number;
        timeToFirstToolMs?: number;
        stitchInvoked: boolean;
    };

    workspaceDiff?: WorkspaceDiff;
};

export type WorkspaceDiff = {
    created: string[];
    modified: string[];
    deleted: string[];
};

export type EvaluationDimensions = {
    executionStatus: AgentRunStatus;
    buildStatus: BuildRunStatus;
    checksStatus: "passed" | "failed" | "skipped";
    judgeStatus: "valid" | "invalid" | "skipped";
};

export const LEGACY_STATUS_MAP: Record<string, AgentRunStatus> = {
    passed_build: "completed",
    failed_build: "build_failed",
    workflow_error: "agent_error",
    timeout: "timeout",
    crashed: "crashed",
    completed: "completed",
    build_failed: "build_failed",
    agent_error: "agent_error",
};

export function normalizeRunStatus(status: string): AgentRunStatus {
    return LEGACY_STATUS_MAP[status] ?? "agent_error";
}

export function isSuccessfulRun(status: string): boolean {
    const n = normalizeRunStatus(status);
    return n === "completed";
}
