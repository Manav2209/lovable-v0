import { sendSSEMessage } from "../../sse";
import { userGivenPromptCheckerNode } from "../tool/code/userGivenPromptChecker";
import { planerNode } from "../tool/code/plannerPrompt";
import { collectWorkspaceFactsNode } from "../tool/templateFacts";
import { validateNode } from "../tool/code/validateBuild";
import { pushNode } from "../tool/r2/push";
import { saveNode } from "../tool/simple/saveContext";
import { runNode } from "../tool/code/buildSource";
import { summarizeChangesNode } from "../tool/simple/summarizeChanges";
import { stitchAppNode } from "../tool/code/stitchApp";
import { runReactLoop } from "./toolLoop";
import { emptyAgentStats, mergeAgentStats, type AgentStats } from "../agentStats";
import { observe } from "../../observability/trace";
import { getActiveTraceId } from "../../observability/langfuse";

export interface WorkflowState {
    projectId: string;
    prompt: string;
    clientId: string;
    analysis?: any;
    enhancedPrompt?: string;
    plan?: string;
    agentPlan?: {
        objective: string;
        areas: string[];
        constraints: string[];
        steps: string[];
    };
    templateFacts?: unknown;
    fileTree?: string;
    toolCalls?: any[];
    context?: any;
    previousContext?: any;
    toolResults?: any[];
    buildStatus?: "pending" | "success" | "errors" | "tested";
    buildErrors?: any[];
    buildOutput?: string;
    errorAnalysis?: any;
    fixAttempts: number;
    maxFixAttempts?: number;
    abortSignal?: AbortSignal;
    completed: boolean;
    error?: string;
    messages: Array<{ role: string; content: string }>;
    threadId: string;
    toolsExecuted?: boolean;
    fixesApplied?: boolean;
    noFixesAvailable?: boolean;
    changeSummary?: {
        filesCreated: string[];
        filesModified: string[];
        filesDeleted: string[];
        commandsExecuted: string[];
        dependenciesAdded: string[];
        dependenciesRemoved: string[];
        buildStatus: string;
        summary: string;
    };
    agentStats?: AgentStats;
    traceId?: string;
}

const ABORT_ERROR = "workflow aborted (eval timeout)";
const MAX_REPAIR_STEPS = Number(process.env.MAX_REPAIR_STEPS || 8);

function isAborted(state: WorkflowState): boolean {
    return state.abortSignal?.aborted === true;
}

async function finishSuccess(state: WorkflowState): Promise<WorkflowState> {
    sendSSEMessage(state.clientId, {
        type: "build_success",
        message: "Build passed, persisting workspace and notifying serve",
    });

    const pushResult = await pushNode(state);
    state = { ...state, ...pushResult };

    const saveResult = await saveNode(state);
    state = { ...state, ...saveResult };

    const runResult = await runNode(state);
    state = { ...state, ...runResult };

    const summaryResult = await summarizeChangesNode(state);
    return { ...state, ...summaryResult };
}

export async function executeWorkflow(initialState: WorkflowState): Promise<WorkflowState> {
    let state = {
        ...initialState,
        agentStats: initialState.agentStats ?? emptyAgentStats(),
        traceId: initialState.traceId ?? getActiveTraceId(),
    };

    try {
        sendSSEMessage(state.clientId, {
            type: "workflow_started",
            message: "Starting ReAct agent workflow",
        });

        const promptCheckResult = await observe("Security", { metadata: { phase: "security" } }, () =>
            userGivenPromptCheckerNode(state),
        );
        state = { ...state, ...promptCheckResult };
        if (state.error) {
            throw new Error(`Prompt validation failed: ${state.error}`);
        }

        const factsResult = await observe("TemplateFacts", { metadata: { phase: "template_facts" } }, () =>
            collectWorkspaceFactsNode(state),
        );
        state = { ...state, ...factsResult };
        if (state.error) {
            throw new Error(`Failed to collect template facts: ${state.error}`);
        }

        const planResult = await observe(
            "Planning",
            { metadata: { phase: "planning" }, input: { prompt: state.prompt } },
            () => planerNode(state),
        );
        state = { ...state, ...planResult };
        if (state.error) {
            throw new Error(`Failed to create plan: ${state.error}`);
        }

        if (isAborted(state)) {
            state.error = ABORT_ERROR;
            state.completed = false;
            return state;
        }

        const reactResult = await observe("ReAct Agent", { metadata: { phase: "react" } }, () =>
            runReactLoop(state),
        );
        state = {
            ...state,
            ...reactResult,
            agentStats: mergeAgentStats(state.agentStats ?? emptyAgentStats(), reactResult.agentStats ?? {}),
        };
        if (state.error) {
            throw new Error(state.error);
        }

        const stitchResult = await stitchAppNode(state);
        state = { ...state, ...stitchResult };
        if ((stitchResult.toolResults || []).some((r: { toolCall?: { tool?: string } }) => r.toolCall?.tool === "stitchApp")) {
            state.agentStats = mergeAgentStats(state.agentStats ?? emptyAgentStats(), { stitchInvoked: true });
        }

        const buildStarted = Date.now();
        const validateResult = await observe(
            "Build",
            {
                metadata: { phase: "build", command: "bun run build" },
            },
            () => validateNode(state),
            (result) => {
                const res = result as Record<string, unknown> | undefined;
                const buildStatus = (res?.buildStatus as string) ?? "unknown";
                const errors = (res?.buildErrors ?? []) as Array<{ type?: string; message?: string }>;
                return {
                    buildStatus,
                    durationMs: Date.now() - buildStarted,
                    diagnosticCategory: errors[0]?.type ?? "none",
                    errorCount: errors.length,
                };
            },
        );
        state = {
            ...state,
            ...validateResult,
            agentStats: mergeAgentStats(state.agentStats ?? emptyAgentStats(), { buildCount: 1 }),
        };

        if (isAborted(state)) {
            state.error = ABORT_ERROR;
            state.completed = false;
            return state;
        }

        const repairBudget = state.maxFixAttempts ?? 2;
        while (state.buildStatus === "errors" && state.fixAttempts < repairBudget && !isAborted(state)) {
            state.fixAttempts += 1;
            sendSSEMessage(state.clientId, {
                type: "repairing",
                message: `Repair attempt ${state.fixAttempts}/${repairBudget}`,
            });

            const diagnostics = [
                "The vite build failed. Inspect the listed files and apply a minimal fix.",
                `Build errors: ${JSON.stringify(state.buildErrors || []).slice(0, 8000)}`,
                state.buildOutput ? `Build output:\n${state.buildOutput.slice(0, 8000)}` : "",
            ].join("\n\n");

            const attempt = state.fixAttempts;
            await observe(
                `Repair ${attempt}`,
                {
                    metadata: {
                        phase: "repair",
                        attempt,
                        diagnosticCategory: state.buildErrors?.[0]?.type ?? "unknown",
                    },
                    input: { diagnostics: state.buildOutput?.slice(0, 2000) },
                },
                async () => {
                    const repair = await runReactLoop(state, diagnostics, MAX_REPAIR_STEPS);
                    state = {
                        ...state,
                        ...repair,
                        error: undefined,
                        agentStats: mergeAgentStats(state.agentStats ?? emptyAgentStats(), repair.agentStats ?? {}),
                    };
                    if (state.error) return repair;
                    const revalidateStarted = Date.now();
                    const revalidate = await observe(
                        "Build",
                        { metadata: { phase: "build", command: "bun run build", repairAttempt: attempt } },
                        () => validateNode(state),
                        (result) => {
                            const res = result as Record<string, unknown> | undefined;
                            const bs = (res?.buildStatus as string) ?? "unknown";
                            const errs = (res?.buildErrors ?? []) as Array<{ type?: string }>;
                            return {
                                buildStatus: bs,
                                durationMs: Date.now() - revalidateStarted,
                                diagnosticCategory: errs[0]?.type ?? "none",
                                errorCount: errs.length,
                            };
                        },
                    );
                    state = {
                        ...state,
                        ...revalidate,
                        agentStats: mergeAgentStats(state.agentStats ?? emptyAgentStats(), { buildCount: 1 }),
                    };
                    return revalidate;
                },
            );
        }

        if (isAborted(state)) {
            state.error = ABORT_ERROR;
            state.completed = false;
            return state;
        }

        if (state.buildStatus === "success") {
            const finished = await finishSuccess(state);
            await observe(
                "Final Result",
                {
                    metadata: {
                        phase: "final",
                        executionStatus: finished.completed ? "completed" : "failed",
                        buildStatus: finished.buildStatus,
                        repairAttempts: finished.fixAttempts,
                        agentSteps: finished.agentStats?.steps,
                        toolCalls: finished.agentStats?.toolCalls,
                    },
                },
                async () => finished,
            );
            return finished;
        }

        if (!state.error) {
            state.error =
                state.buildStatus === "errors"
                    ? "Build failed after repair budget"
                    : "Workflow ended without a successful build";
        }

        if (state.toolResults && state.toolResults.length > 0) {
            const summaryResult = await summarizeChangesNode(state);
            state = { ...state, ...summaryResult };
        }

        state.completed = false;
        await observe(
            "Final Result",
            {
                metadata: {
                    phase: "final",
                    executionStatus: "failed",
                    buildStatus: state.buildStatus,
                    error: state.error,
                    repairAttempts: state.fixAttempts,
                    agentSteps: state.agentStats?.steps,
                    toolCalls: state.agentStats?.toolCalls,
                },
            },
            async () => state,
        );
        return state;
    } catch (error) {
        console.error("Workflow execution error:", error);
        const errorMessage = error instanceof Error ? error.message : String(error);

        sendSSEMessage(state.clientId, {
            type: "error",
            message: `Workflow failed: ${errorMessage}`,
        });

        state.error = errorMessage;
        state.completed = false;

        if (state.toolResults && state.toolResults.length > 0 && !isAborted(state)) {
            const summaryResult = await summarizeChangesNode(state);
            state = { ...state, ...summaryResult };
        }

        await observe(
            "Final Result",
            {
                metadata: {
                    phase: "final",
                    executionStatus: "crashed",
                    error: state.error,
                    repairAttempts: state.fixAttempts,
                    agentSteps: state.agentStats?.steps,
                    toolCalls: state.agentStats?.toolCalls,
                },
            },
            async () => state,
        );

        return state;
    }
}
