import { sendSSEMessage, getProjectSSEUrl } from "../../sse";
import { executeMainFlow } from "../graphs/main";
import { getProjectMemories, saveConversationMemory } from "../../memory";
import { publishStreamEvent } from "../../events/sink";
import { ControlToOrchestrator, PROMPT_RESPONSE } from "types";

export async function processPrompt(
  projectId: string,
  prompt: string,
): Promise<void> {
  console.log(`Starting agent processing for project ${projectId}: ${prompt}`);

  const clientIdUsed = projectId;

  try {
    const memories = await getProjectMemories(projectId);

    sendSSEMessage(clientIdUsed, {
      type: "started",
      message: "Processing prompt...",
    });

    await publishStreamEvent(ControlToOrchestrator, {
      data: JSON.stringify({
          projectId: projectId,
          type: PROMPT_RESPONSE,
          payload: getProjectSSEUrl(clientIdUsed)
      })
    }, { projectId });
    console.log(`Sent SSE URL to orchestrator for project ${projectId}: ${getProjectSSEUrl(clientIdUsed)}`);

    let finalState;
    try {
      finalState = await executeMainFlow({
        projectId,
        prompt,
        previousContext: memories.slice(-5),
        clientId: clientIdUsed,
        fixAttempts: 0,
        maxFixAttempts: Number(process.env.MAX_FIX_ATTEMPTS || 5),
        completed: false,
        messages: [],
        threadId: projectId,
      });
    } catch (flowError) {
        console.error(`Flow execution error for project ${projectId}:`, flowError);
        sendSSEMessage(clientIdUsed, {
            type: "error",
            message: "Flow execution failed",
            error: flowError instanceof Error ? flowError.message : String(flowError),
        });
        return;
    }

    if (finalState.completed) {
        sendSSEMessage(clientIdUsed, {
            type: "completed",
            message: "Project updated successfully",
            result: finalState,
        });

        const aiResponse = `Workflow completed: ${finalState.buildStatus}`;

        await saveConversationMemory(projectId, prompt, aiResponse);

        console.log(`Agent completed successfully for project ${projectId}`);
    } else {
      sendSSEMessage(clientIdUsed, {
        type: "error",
        message: "Failed to complete the task",
        error: finalState.error,
      });

      console.error(`Agent failed for project ${projectId}:`, finalState.error);
    }
  } catch (error) {
    console.error(`Agent handler error for project ${projectId}:`, error);

    sendSSEMessage(clientIdUsed, {
      type: "error",
      message: "Unexpected error during processing",
      error: error instanceof Error ? error.message : String(error),
    });
  }
}
