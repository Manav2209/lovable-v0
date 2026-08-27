import { NodeSDK } from "@opentelemetry/sdk-node";
import { LangfuseSpanProcessor } from "@langfuse/otel";

/**
 * Deterministically decide whether Langfuse observability is enabled.
 *
 * Enabled when both credentials are present AND LANGFUSE_ENABLED is not "0".
 * Kept as an exported pure function so the eval runner can reason about the
 * same flag without re-starting the SDK.
 */
export function isLangfuseConfigured(): boolean {
    if (process.env.LANGFUSE_ENABLED === "0") return false;
    return Boolean(
        process.env.LANGFUSE_PUBLIC_KEY && process.env.LANGFUSE_SECRET_KEY,
    );
}

let started = false;
let sdk: NodeSDK | null = null;
let processor: LangfuseSpanProcessor | null = null;

/**
 * Bootstraps OpenTelemetry with the Langfuse span processor.
 *
 * MUST be imported (side-effect) before any LLM model is constructed so that
 * LangChain callback-handler spans and @langfuse/tracing observations nest
 * under the same tracer. Safe to call more than once (idempotent).
 *
 * When observability is disabled this is a no-op, preserving hermetic eval.
 */
export function startLangfuseInstrumentation(): void {
    if (started || !isLangfuseConfigured()) return;
    started = true;

    const activeProcessor = new LangfuseSpanProcessor({
        publicKey: process.env.LANGFUSE_PUBLIC_KEY,
        secretKey: process.env.LANGFUSE_SECRET_KEY,
        baseUrl:
            process.env.LANGFUSE_BASE_URL || "https://cloud.langfuse.com",
        environment: process.env.LANGFUSE_TRACING_ENVIRONMENT || "eval",
        exportMode: "immediate",
    });
    processor = activeProcessor;

    sdk = new NodeSDK({
        serviceName: "lovable-agent",
        spanProcessors: [activeProcessor],
    });

    sdk.start();
}

/**
 * Forces a flush of any pending Langfuse spans, e.g. before process exit so a
 * short-lived eval run is not left partially exported. No-op when disabled.
 */
export async function forceLangfuseFlush(): Promise<void> {
    if (!processor) return;
    await processor.forceFlush();
}

// Side-effect: intent is that importing this file performs the bootstrap.
startLangfuseInstrumentation();
