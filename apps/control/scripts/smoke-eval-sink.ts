/**
 * Headless smoke test for the eval event sink.
 *
 * Verifies, WITHOUT any Redis/K8s/R2 infrastructure:
 *   1. Importing the agent pipeline does not connect to Redis or hard-exit.
 *   2. EVAL_MODE=1 captures SSE + stream events into the memory ring.
 *   3. Events are durably appended to the EVAL_EVENT_LOG JSONL file.
 *   4. Stream publishes are skipped (redisSkipped=true) in eval mode.
 *
 * Run: EVAL_MODE=1 bun run ./scripts/smoke-eval-sink.ts
 */
import fs from "fs";
import os from "os";
import path from "path";

process.env.EVAL_MODE = "1";

const logPath = path.join(os.tmpdir(), `eval-sink-smoke-${Date.now()}.jsonl`);
process.env.EVAL_EVENT_LOG = logPath;

async function main() {
    // Dynamic imports AFTER env setup so sinks compose correctly.
    const { getMemoryEvents, publishStreamEvent, flushEventSink } = await import(
        "../src/events/sink"
    );
    const { buildProjectAndNotifyToRun } = await import(
        "../src/agent/tool/code/buildSource"
    );
    const { sendSSEMessage } = await import("../src/sse");

    // 1. SSE event capture
    sendSSEMessage("smoke-client", { type: "started", message: "smoke" });

    // 2. Stream event capture (Redis skipped in eval mode)
    await publishStreamEvent(
        "smoke:stream",
        {
            data: JSON.stringify({
                type: "SMOKE_EVENT",
                projectId: "proj_smoke",
            }),
        },
        { projectId: "proj_smoke" },
    );

    // 3. Agent function against a nonexistent project dir — exercises the
    //    PROJECT_FAILED publish path end-to-end without Redis.
    const buildResult = await buildProjectAndNotifyToRun("proj_missing");

    // Durability: wait for all in-flight JSONL writes before reading.
    await flushEventSink();

    const events = getMemoryEvents();
    if (events.length < 3) {
        throw new Error(`Expected >=3 captured events, got ${events.length}`);
    }

    const rawLines = fs.readFileSync(logPath, "utf8").trim().split("\n");
    if (rawLines.length !== events.length) {
        throw new Error(
            `JSONL/file mismatch: ${rawLines.length} lines vs ${events.length} memory events`,
        );
    }
    for (const line of rawLines) {
        const parsed = JSON.parse(line);
        if (!parsed.timestamp || !parsed.event || !parsed.service) {
            throw new Error("Malformed event schema: " + line);
        }
    }

    const streamEvent = events.find((e) => e.event === "agent.stream.publish");
    if (!streamEvent?.metadata?.redisSkipped) {
        throw new Error("Expected redisSkipped=true on stream event in eval mode");
    }

    console.log("buildResult (expected false):", buildResult);
    console.log("capturedEvents:", events.map((e) => `${e.event}(${e.metadata?.type ?? e.metadata?.stream ?? ""})`).join(", "));
    console.log("JSONL written to:", logPath);
    console.log("SMOKE OK — agent imports and runs fully headless");
}

main().catch((err) => {
    console.error("SMOKE FAILED:", err);
    process.exit(1);
});
