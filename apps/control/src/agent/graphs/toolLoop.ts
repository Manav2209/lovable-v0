import { HumanMessage, SystemMessage, ToolMessage } from "@langchain/core/messages";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { model } from "../client";
import { SYSTEM_PROMPTS } from "../../prompt/systemPrompt";
import { sendSSEMessage } from "../../sse";
import { requireAgentRuntime } from "../runtime";
import { codingAgentTools } from "../tool/codingTools";
import type { WorkflowState } from "./workflow";
import { emptyAgentStats, recordToolUse, type AgentStats } from "../agentStats";
import { observe } from "../../observability/trace";

const MAX_AGENT_STEPS = Number(process.env.MAX_AGENT_STEPS || 20);
const MAX_TOOL_CALLS = Number(process.env.MAX_TOOL_CALLS || 40);
const MAX_RUNTIME_MS = Number(process.env.MAX_AGENT_RUNTIME_MS || 8 * 60_000);
const STALL_REPEAT = 3;

const RETRIEVAL_TOOLS = new Set(["listDir", "grepSearch", "readFile"]);
const MUTATION_TOOLS = new Set(["createFile", "updateFile", "replaceInFile", "deleteFile"]);

type ToolCall = { id?: string; name: string; args: Record<string, unknown> };

function extractToolCalls(response: { tool_calls?: ToolCall[] }): ToolCall[] {
    return Array.isArray(response.tool_calls) ? response.tool_calls : [];
}

function bindModel() {
    const maybeBind = model as BaseChatModel & {
        bindTools?: (tools: typeof codingAgentTools) => BaseChatModel;
    };
    if (typeof maybeBind.bindTools === "function") {
        return maybeBind.bindTools(codingAgentTools);
    }
    return model;
}

const toolMap = Object.fromEntries(codingAgentTools.map((t) => [t.name, t]));

function extractUsageMetadata(response: unknown): Record<string, unknown> | undefined {
    if (!response || typeof response !== "object") return undefined;
    const msg = response as Record<string, unknown>;
    const usage = msg.usage_metadata as Record<string, unknown> | undefined;
    if (!usage) return undefined;
    return {
        promptTokens: usage.input_tokens,
        completionTokens: usage.output_tokens,
        totalTokens: usage.total_tokens,
    };
}

export async function runReactLoop(
    state: WorkflowState,
    extraUserMessage?: string,
    maxSteps = MAX_AGENT_STEPS,
): Promise<Partial<WorkflowState>> {
    const runtime = requireAgentRuntime();
    const started = Date.now();
    const bound = bindModel();

    const facts = state.templateFacts ? JSON.stringify(state.templateFacts, null, 2) : "{}";
    const plan = state.agentPlan ? JSON.stringify(state.agentPlan, null, 2) : state.plan || "";

    const messages: unknown[] = [
        new SystemMessage(
            SYSTEM_PROMPTS.REACT_SYSTEM_PROMPT +
                `\n\nTemplateFacts:\n${facts}\n\nFile tree:\n${state.fileTree || ""}`,
        ),
        new HumanMessage(
            `User request:\n${state.prompt}\n\nIntent plan:\n${plan}` +
                (extraUserMessage ? `\n\n${extraUserMessage}` : ""),
        ),
    ];

    const toolResults: unknown[] = [...(state.toolResults || [])];
    let toolCalls = 0;
    const stall: string[] = [];
    const stats: AgentStats = emptyAgentStats();
    const loopStarted = started;

    sendSSEMessage(state.clientId, {
        type: "react_start",
        message: extraUserMessage ? "Repairing after build failure..." : "Inspecting and editing the project...",
    });

    for (let step = 0; step < maxSteps; step++) {
        if (runtime.abortSignal.aborted || state.abortSignal?.aborted) {
            return { error: "workflow aborted (eval timeout)", toolResults, agentStats: stats };
        }
        if (Date.now() - started > MAX_RUNTIME_MS) {
            return { error: `Exceeded MAX_AGENT_RUNTIME_MS of ${MAX_RUNTIME_MS}`, toolResults, agentStats: stats };
        }

        stats.steps += 1;
        const stepNumber = stats.steps;

        const stepStarted = Date.now();

        const response = await observe(
            `ReAct Step ${stepNumber}`,
            {
                metadata: { phase: "react_step", stepNumber },
            },
            async () => bound.invoke(messages as never),
            (result) => ({
                ...extractUsageMetadata(result),
                stepDurationMs: Date.now() - stepStarted,
            }),
        );
        const calls = extractToolCalls(response as { tool_calls?: ToolCall[] });

        if (!calls.length) {
            sendSSEMessage(state.clientId, {
                type: "react_complete",
                message: `ReAct finished after ${stats.steps} step(s)`,
            });
            return { toolResults, toolsExecuted: true, agentStats: stats };
        }

        messages.push(response);

        for (const call of calls) {
            if (toolCalls >= MAX_TOOL_CALLS) {
                return { error: `Exceeded MAX_TOOL_CALLS of ${MAX_TOOL_CALLS}`, toolResults, toolsExecuted: true, agentStats: stats };
            }

            const signature = `${call.name}:${JSON.stringify(call.args)}`;
            stall.push(signature);
            if (stall.length > STALL_REPEAT) stall.shift();
            if (stall.length === STALL_REPEAT && stall.every((s) => s === stall[0])) {
                return {
                    error: `Agent stalled repeating ${call.name}`,
                    toolResults,
                    toolsExecuted: true,
                    agentStats: stats,
                };
            }

            sendSSEMessage(state.clientId, {
                type: "tool_executing",
                message: `Executing: ${call.name}`,
                toolName: call.name,
            });

            const tool = toolMap[call.name];
            const isRetrieval = RETRIEVAL_TOOLS.has(call.name);

            const executeTool = async () => {
                if (!tool) {
                    return { success: false, message: `Unknown tool: ${call.name}` };
                }
                try {
                    return await (tool as { invoke: (args: unknown) => Promise<unknown> }).invoke(
                        call.args ?? {},
                    );
                } catch (error) {
                    return {
                        success: false,
                        message: error instanceof Error ? error.message : String(error),
                    };
                }
            };

            const toolResult = isRetrieval
                ? await observe(
                    "Retrieval",
                    { metadata: { phase: "retrieval", stepNumber } },
                    () =>
                        observe(
                            `tool:${call.name}`,
                            {
                                metadata: {
                                    phase: "retrieval",
                                    stepNumber,
                                    toolName: call.name,
                                },
                                input: call.args,
                            },
                            executeTool,
                        ),
                  )
                : await observe(
                    `tool:${call.name}`,
                    {
                        metadata: {
                            phase: "tool",
                            stepNumber,
                            toolName: call.name,
                        },
                        input: call.args,
                    },
                    executeTool,
                  );

            if (MUTATION_TOOLS.has(call.name) && toolResult && typeof toolResult === "object") {
                const res = toolResult as Record<string, unknown>;
                const files = (res.changedFiles ?? res.files ?? res.created ?? res.modified) as
                    | string | string[] | undefined;
                if (Array.isArray(files)) {
                    stats.changedFiles.push(...files);
                } else if (typeof files === "string" && files) {
                    stats.changedFiles.push(files);
                }
            }

            toolCalls += 1;
            recordToolUse(stats, call.name, Date.now() - loopStarted);
            toolResults.push({ toolCall: { tool: call.name, args: call.args }, result: toolResult });

            sendSSEMessage(state.clientId, {
                type: toolResult && typeof toolResult === "object" && "success" in toolResult && (toolResult as { success: boolean }).success === false
                    ? "tool_error"
                    : "tool_completed",
                message: `Completed: ${call.name}`,
                toolName: call.name,
            });

            messages.push(
                new ToolMessage({
                    content: JSON.stringify(toolResult),
                    tool_call_id: call.id || call.name,
                }),
            );
        }
    }

    return {
        error: `Exceeded MAX_AGENT_STEPS of ${maxSteps}`,
        toolResults,
        toolsExecuted: true,
        agentStats: stats,
    };
}
