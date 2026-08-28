import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { CallbackHandler } from "@langfuse/langchain";
import {
    startActiveObservation,
    propagateAttributes,
} from "@langfuse/tracing";
import { isLangfuseConfigured } from "./instrumentation";

export interface TraceCaseOptions {
    runId: string;
    caseId: string;
    tier: string;
    prompt: string;
}

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

/**
 * Runs `fn` inside a Langfuse trace named `run<runId>:<caseId>` with the run as
 * the session, so every trace (and its child LLM/tool spans) can be grouped and
 * queried per eval case in Langfuse. Returns the callback result.
 */
export async function traceCase<T, F extends (...args: any[]) => Promise<T>>(
    options: TraceCaseOptions,
    fn: F,
): Promise<T> {
    if (!isLangfuseConfigured()) return fn();

    const traceName = `run${options.runId}:${options.caseId}`;

    return propagateAttributes(
        {
            traceName,
            sessionId: options.runId,
            userId: options.caseId,
            tags: ["eval", options.tier],
            metadata: {
                runId: options.runId,
                caseId: options.caseId,
                tier: options.tier,
            },
        },
        () =>
            startActiveObservation(traceName, async () => {
                return await fn();
            }),
    );
}


