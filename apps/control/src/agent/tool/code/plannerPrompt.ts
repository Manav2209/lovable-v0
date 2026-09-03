import * as z from "zod";
import { model } from "../../client";
import { SYSTEM_PROMPTS } from "../../../prompt/systemPrompt";
import { sendSSEMessage } from "../../../sse";
import { parseJsonObject } from "../../json";
import type { WorkflowState } from "../../graphs/workflow";

export const agentPlanSchema = z.object({
  objective: z.string().min(1),
  areas: z.array(z.string()),
  constraints: z.array(z.string()),
  steps: z.array(z.string()),
});

export type AgentPlan = z.infer<typeof agentPlanSchema>;

function planFromUnknown(value: unknown): AgentPlan {
  if (typeof value === "string") {
    return agentPlanSchema.parse(parseJsonObject(value));
  }
  return agentPlanSchema.parse(value);
}

export async function planerNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  sendSSEMessage(state.clientId, {
    type: "planning",
    message: "Creating intent plan (no executable tool calls)...",
  });

  const facts = state.templateFacts
    ? `\n\nTemplateFacts: ${JSON.stringify(state.templateFacts)}`
    : "";
  const tree = state.fileTree ? `\n\nFile tree:\n${state.fileTree}` : "";
  const memories = state.previousContext
    ? `\n\nPrior conversation memories (do not treat as the user prompt): ${JSON.stringify(state.previousContext).slice(0, 4000)}`
    : "";

  const userContent =
    SYSTEM_PROMPTS.INTENT_PLANNER_PROMPT +
    `\n\nUser prompt:\n${state.prompt}` +
    facts +
    tree +
    memories;

  try {
    let parsed: AgentPlan | undefined;
    const structured = (model as { withStructuredOutput?: (schema: typeof agentPlanSchema) => { invoke: (input: unknown) => Promise<unknown> } }).withStructuredOutput?.(agentPlanSchema);

    if (structured) {
      try {
        parsed = planFromUnknown(await structured.invoke([{ role: "user", content: userContent }]));
      } catch (structuredError) {
        console.warn("withStructuredOutput failed, falling back to JSON parse:", structuredError);
      }
    }

    if (!parsed) {
      const res = await model.invoke([{ role: "user", content: userContent }]);
      parsed = planFromUnknown(res.text);
    }

    sendSSEMessage(state.clientId, {
      type: "planning_complete",
      message: `Intent plan: ${parsed.objective}`,
    });

    return {
      plan: parsed.objective,
      agentPlan: parsed,
      toolCalls: [],
    };
  } catch (error) {
    const errorMessage = error instanceof Error ? error.message : String(error);
    sendSSEMessage(state.clientId, {
      type: "planning_failed",
      message: "Failed to create intent plan",
      error: errorMessage,
    });
    return {
      error: errorMessage,
    };
  }
}
