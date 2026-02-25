

import { sendSSEMessage, getProjectSSEUrl } from "../../sse";
import { executeMainFlow } from "../graphs/main";
import { getProjectMemories, saveConversationMemory } from "../../memory";
import { redis } from "../..";
import { ControlToOrchestator, OrchestatorToBackend, PROMPT_RESPONSE } from "types";

export async function processPrompt(
  projectId: string,
  prompt: string,
  
): Promise<void> {
  console.log(`Starting agent processing for project ${projectId}: ${prompt}`);

  const clientIdUsed = projectId;

  try {
    const memories = await getProjectMemories(projectId);
    const contextInfo = memories.length > 0 ? `Previous context: ${JSON.stringify(memories.slice(-5))}` : "";

    sendSSEMessage(clientIdUsed, {
      type: "started",
      message: "Processing prompt...",
    });

    await redis.xAdd(ControlToOrchestator , "*" , {
      value : JSON.stringify({
        key: projectId,
        value: PROMPT_RESPONSE + "|" + getProjectSSEUrl(clientIdUsed),
      })

    })
    console.log(`Sent SSE URL to orchestrator for project ${projectId}: ${getProjectSSEUrl(clientIdUsed)}`);

    let finalState;
    try {
      finalState = await executeMainFlow({
        projectId,
        prompt: prompt + (contextInfo ? `\n\n${contextInfo}` : ""),
        clientId: clientIdUsed,
        fixAttempts: 0,
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


        await redis.xAdd(OrchestatorToBackend , "*" , {
            key: projectId , 
            value : `AI_RESPONSE: ${aiResponse}` 
        })
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