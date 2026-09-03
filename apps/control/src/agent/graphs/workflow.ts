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
    let state = { ...initialState };

    try {
        sendSSEMessage(state.clientId, {
            type: "workflow_started",
            message: "Starting ReAct agent workflow",
        });

        const promptCheckResult = await userGivenPromptCheckerNode(state);
        state = { ...state, ...promptCheckResult };
        if (state.error) {
            throw new Error(`Prompt validation failed: ${state.error}`);
        }

        const factsResult = await collectWorkspaceFactsNode(state);
        state = { ...state, ...factsResult };
        if (state.error) {
            throw new Error(`Failed to collect template facts: ${state.error}`);
        }

        const planResult = await planerNode(state);
        state = { ...state, ...planResult };
        if (state.error) {
            throw new Error(`Failed to create plan: ${state.error}`);
        }

        if (isAborted(state)) {
            state.error = ABORT_ERROR;
            state.completed = false;
            return state;
        }

        const reactResult = await runReactLoop(state);
        state = { ...state, ...reactResult };
        if (state.error) {
            throw new Error(state.error);
        }

        const stitchResult = await stitchAppNode(state);
        state = { ...state, ...stitchResult };

        const validateResult = await validateNode(state);
        state = { ...state, ...validateResult };

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

            const repair = await runReactLoop(state, diagnostics, MAX_REPAIR_STEPS);
            state = { ...state, ...repair, error: undefined };

            if (state.error) break;

            const revalidate = await validateNode(state);
            state = { ...state, ...revalidate };
        }

        if (isAborted(state)) {
            state.error = ABORT_ERROR;
            state.completed = false;
            return state;
        }

        if (state.buildStatus === "success") {
            return await finishSuccess(state);
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

        return state;
    }
}
