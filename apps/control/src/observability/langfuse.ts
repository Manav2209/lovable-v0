import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { CallbackHandler } from "@langfuse/langchain";
import { isLangfuseConfigured } from "./instrumentation";

export {
    observe,
    traceAgentRun,
    traceCase,
    getActiveTraceId,
    type AgentTraceOptions,
} from "./trace";

let sharedHandler: CallbackHandler | null = null;

/**
 * Lazily-builds a single shared LangChain callback handler.
 *
 * IMPORTANT: fresh handler instances cause silent capture failures, so we reuse
 * one handler for the whole process, attached to every constructed model.
 */
export function getLangfuseHandler(): CallbackHandler | null {
    if (!isLangfuseConfigured()) return null;
    if (!sharedHandler) {
        sharedHandler = new CallbackHandler({
            traceMetadata: { framework: "lovable-agent" },
        });
    }
    return sharedHandler;
}

/**
 * Attaches the shared Langfuse handler to a freshly built model so all
 * model.invoke() calls (and tool() calls) are auto-captured as spans.
 * No-op when Langfuse is disabled.
 */
export function injectLangfuse(model: BaseChatModel): BaseChatModel {
    const handler = getLangfuseHandler();
    if (!handler) return model;
    try {
        model.callbacks = [handler];
    } catch {
        /* some model bindings treat callbacks as read-only; best-effort */
    }
    return model;
}
