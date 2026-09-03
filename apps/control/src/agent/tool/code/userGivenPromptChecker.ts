import { tool } from "langchain";
import * as z from "zod";
import { SYSTEM_PROMPTS } from "../../../prompt/systemPrompt";
import { model } from "../../client";
import { sendSSEMessage } from "../../../sse";
import { parseJsonObject } from "../../json";
import type { WorkflowState } from "../../graphs/workflow";

const userGivenPromptSchema = z.string().min(1).max(16_000);

const securityVerdictSchema = z.object({
  isSafe: z.boolean(),
  reason: z.string().optional(),
});

export const checkUserGivenPrompt = tool(
  async (
    input: z.infer<typeof userGivenPromptSchema>,
  ): Promise<{ success: boolean; message: any; error?: string }> => {
    try {
      const res = await model.invoke([
        {
          role: "user",
          content:
            SYSTEM_PROMPTS.SECURITY_PROMPT + `\n\n User Given Prompt: ${input}`,
        },
      ]);

      let parsedMessage;
      try {
        parsedMessage = securityVerdictSchema.parse(parseJsonObject(res.text));
      } catch (parseError) {
        console.error("Failed to parse LLM response as JSON:", parseError);
        console.error("LLM response:", res.text.substring(0, 500));

        return {
          success: false,
          message: { isSafe: false, reason: "Security checker returned invalid JSON" },
          error: "Security check failed closed: could not parse verdict",
        };
      }

      return {
        success: true,
        message: parsedMessage,
      };
    } catch (error) {
      console.error("Error in checkUserGivenPrompt:", error);
      const errorMessage =
        error instanceof Error ? error.message : String(error);
      return {
        success: false,
        message: "Validation failed due to an error.",
        error: errorMessage,
      };
    }
  },
  {
    name: "checkUserGivenPrompt",
    description:
      "Checks if the user given prompt is safe and does not contain any malicious content.",
    schema: userGivenPromptSchema,
  },
);

export async function userGivenPromptCheckerNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  sendSSEMessage(state.clientId, {
    type: "checking_prompt",
    message: "Checking prompt for safety and security...",
  });

  const result = await checkUserGivenPrompt.invoke(state.prompt);

  if (!result.success) {
    sendSSEMessage(state.clientId, {
      type: "prompt_check_failed",
      message: "Prompt validation failed",
      error: result.error,
    });
    return {
      error: result.error || "Prompt validation failed",
    };
  }

  const validation = result.message;

  if (!validation.isSafe) {
    sendSSEMessage(state.clientId, {
      type: "prompt_unsafe",
      message: "Prompt contains unsafe or malicious content",
      reason: validation.reason,
    });
    return {
      error: `Unsafe prompt: ${validation.reason}`,
    };
  }

  sendSSEMessage(state.clientId, {
    type: "prompt_check_passed",
    message: "Prompt validation passed successfully",
  });

  return {};
}
