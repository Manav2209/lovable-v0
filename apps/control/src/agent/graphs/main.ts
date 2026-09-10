import { createAgentRuntime, runWithAgentRuntime } from "../runtime";
import { executeWorkflow } from "./workflow";
import type { WorkflowState } from "./workflow";

export type { WorkflowState } from "./workflow";

export { executeWorkflow } from "./workflow";

export async function executeMainFlow(initialState: WorkflowState): Promise<WorkflowState> {
    const runtime = createAgentRuntime(initialState.projectId, initialState.abortSignal);
    return runWithAgentRuntime(runtime, () => executeWorkflow(initialState));
}