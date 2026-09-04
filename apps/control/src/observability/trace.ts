import { AsyncLocalStorage } from "node:async_hooks";
import { startActiveObservation, propagateAttributes } from "@langfuse/tracing";
import { isLangfuseConfigured } from "./instrumentation";
import { sanitizeForObservability } from "./sanitize";

export interface AgentTraceOptions {
    runId: string;
    caseId?: string;
    projectId: string;
    prompt: string;
    tier?: string;
    agentMode: "eval" | "production";
}

type ObservationHandle = {
    update?: (fields: Record<string, unknown>) => void;
};

function agentVersion(): string {
    return process.env.AGENT_VERSION || "react-v1";
}

function templateVersion(): string {
    return process.env.TEMPLATE_VERSION || "disk";
}

/**
 * Wraps work in a named Langfuse observation. No-op when Langfuse is disabled.
 */
export async function observe<T>(
    name: string,
    fields: {
        metadata?: Record<string, unknown>;
        input?: unknown;
        asType?: string;
    },
    fn: () => Promise<T>,
    enrich?: (result: T) => Record<string, unknown>,
): Promise<T> {
    if (!isLangfuseConfigured()) return fn();

    return startActiveObservation(name, async (observation: ObservationHandle) => {
        observation.update?.({
            input: sanitizeForObservability(fields.input),
            metadata: sanitizeForObservability({
                agentVersion: agentVersion(),
                ...fields.metadata,
            }) as Record<string, unknown>,
        });
        try {
            const result = await fn();
            const extraMeta = enrich?.(result);
            observation.update?.({
                output: sanitizeForObservability(summarizeOutput(result)),
                ...(extraMeta ? { metadata: sanitizeForObservability({ ...fields.metadata, ...extraMeta }) as Record<string, unknown> } : {}),
            });
            return result;
        } catch (error) {
            observation.update?.({
                level: "ERROR",
                statusMessage: error instanceof Error ? error.message : String(error),
            });
            throw error;
        }
    });
}

function summarizeOutput(result: unknown): unknown {
    if (result == null) return result;
    if (typeof result !== "object") return result;
    const rec = result as Record<string, unknown>;
    if ("error" in rec || "buildStatus" in rec || "success" in rec || "message" in rec) {
        return {
            success: rec.success,
            error: rec.error,
            message: rec.message,
            buildStatus: rec.buildStatus,
            completed: rec.completed,
            changedFiles: rec.changedFiles,
        };
    }
    return result;
}

const traceIdStore = new AsyncLocalStorage<string>();

export function getActiveTraceId(): string | undefined {
    return traceIdStore.getStore();
}

function makeTraceId(): string {
    return `lf_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

/**
 * One top-level trace per agent run (eval case or user prompt).
 */
export async function traceAgentRun<T>(
    options: AgentTraceOptions,
    fn: () => Promise<T>,
): Promise<{ value: T; traceId?: string }> {
    const traceId = makeTraceId();
    const run = async (): Promise<{ value: T; traceId: string }> => {
        if (!isLangfuseConfigured()) {
            return { value: await fn(), traceId };
        }

        const traceName = options.caseId
            ? `eval:${options.runId}:${options.caseId}`
            : `prod:${options.projectId}:${options.runId}`;
        const tags = options.agentMode === "eval"
            ? ["eval", options.tier ?? "untiered"]
            : ["production"];

        const value = await propagateAttributes(
            {
                traceName,
                sessionId: options.runId,
                userId: options.caseId ?? options.projectId,
                tags,
                metadata: sanitizeForObservability({
                    runId: options.runId,
                    caseId: options.caseId,
                    projectId: options.projectId,
                    agentVersion: agentVersion(),
                    agentMode: options.agentMode,
                    templateVersion: templateVersion(),
                    environment:
                        process.env.LANGFUSE_TRACING_ENVIRONMENT ||
                        process.env.NODE_ENV ||
                        "unknown",
                    prompt: options.prompt,
                    traceId,
                }) as Record<string, string>,
            },
            () =>
                startActiveObservation(traceName, async (observation: ObservationHandle) => {
                    observation.update?.({
                        input: sanitizeForObservability({ prompt: options.prompt }),
                        metadata: { traceId, agentMode: options.agentMode },
                    });
                    return fn();
                }),
        );
        return { value, traceId };
    };

    return traceIdStore.run(traceId, run);
}

/** @deprecated Use traceAgentRun. Kept for existing eval runner call sites. */
export async function traceCase<T>(
    options: {
        runId: string;
        caseId: string;
        tier: string;
        prompt: string;
        projectId?: string;
    },
    fn: () => Promise<T>,
): Promise<T> {
    const wrapped = await traceAgentRun(
        {
            runId: options.runId,
            caseId: options.caseId,
            projectId: options.projectId ?? options.caseId,
            prompt: options.prompt,
            tier: options.tier,
            agentMode: "eval",
        },
        fn,
    );
    return wrapped.value;
}
