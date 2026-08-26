import fs from "fs";
import path from "path";
import { publish } from "shared-redis";

export type AgentEventStatus = "success" | "error" | "pending";

export interface AgentEvent {
    /** Correlation id for a whole eval run / workflow execution (eval-side). */
    runId?: string;
    projectId?: string;
    clientId?: string;
    service: string;
    event: string;
    timestamp: number;
    durationMs?: number;
    status?: AgentEventStatus;
    metadata?: Record<string, unknown>;
}

export interface EventSink {
    record(event: AgentEvent): Promise<void> | void;
    /** Resolves when all previously issued writes are durably stored. */
    flush(): Promise<void>;
}

export function isEvalMode(): boolean {
    return process.env.EVAL_MODE === "1";
}

const DEFAULT_MEMORY_CAP = 500;

export class MemorySink implements EventSink {
    private events: AgentEvent[] = [];

    constructor(private readonly cap: number = DEFAULT_MEMORY_CAP) {}

    record(event: AgentEvent): void {
        this.events.push(event);
        if (this.events.length > this.cap) {
            this.events.splice(0, this.events.length - this.cap);
        }
    }

    async flush(): Promise<void> {}

    getEvents(): readonly AgentEvent[] {
        return this.events;
    }

    clear(): void {
        this.events = [];
    }
}

export class FileSink implements EventSink {
    private readonly dirReady: Promise<void>;
    private readonly pending = new Set<Promise<void>>();

    constructor(private readonly filePath: string) {
        this.dirReady = fs.promises
            .mkdir(path.dirname(filePath), { recursive: true })
            .then(() => undefined);
    }

    record(event: AgentEvent): Promise<void> {
        const write = this.dirReady
            .then(() =>
                fs.promises.appendFile(
                    this.filePath,
                    JSON.stringify(event) + "\n",
                    "utf8",
                ),
            )
            .finally(() => this.pending.delete(write));
        this.pending.add(write);
        return write;
    }

    async flush(): Promise<void> {
        await Promise.allSettled([...this.pending]);
    }
}

export class MultiSink implements EventSink {
    constructor(private readonly sinks: EventSink[]) {}

    async record(event: AgentEvent): Promise<void> {
        await Promise.all(
            this.sinks.map(async (sink) => {
                try {
                    await sink.record(event);
                } catch (err) {
                    console.error("[events] sink failed:", err);
                }
            }),
        );
    }

    async flush(): Promise<void> {
        await Promise.all(this.sinks.map((s) => s.flush()));
    }
}

class NoopSink implements EventSink {
    record(): void {}
    async flush(): Promise<void> {}
}

let sinkInstance: EventSink | null = null;
let memorySinkInstance: MemorySink | null = null;

export function getEventSink(): EventSink {
    if (!sinkInstance) {
        if (!isEvalMode()) {
            sinkInstance = new NoopSink();
            return sinkInstance;
        }

        memorySinkInstance = new MemorySink();
        const sinks: EventSink[] = [memorySinkInstance];
        const eventLogPath = process.env.EVAL_EVENT_LOG;
        if (eventLogPath) {
            sinks.push(new FileSink(eventLogPath));
        }
        sinkInstance = new MultiSink(sinks);
    }
    return sinkInstance;
}

/** Test/harness hook to recompose sinks after env changes. */
export function resetEventSink(): void {
    sinkInstance = null;
    memorySinkInstance = null;
}

/**
 * Resolves once every event issued so far is durably stored.
 * Eval runners must call this before reading the JSONL log or exiting.
 */
export async function flushEventSink(): Promise<void> {
    await getEventSink().flush();
}

export function getMemoryEvents(): readonly AgentEvent[] {
    if (!memorySinkInstance) getEventSink();
    return memorySinkInstance ? memorySinkInstance.getEvents() : [];
}

export interface RecordAgentEventOptions {
    runId?: string;
    projectId?: string;
    clientId?: string;
    service?: string;
    event: string;
    durationMs?: number;
    status?: AgentEventStatus;
    metadata?: Record<string, unknown>;
}

/**
 * Records an observability event. No-op unless EVAL_MODE=1, so production
 * pods are completely unaffected.
 */
export function recordAgentEvent(options: RecordAgentEventOptions): void {
    if (!isEvalMode()) return;

    void getEventSink().record({
        runId: options.runId,
        projectId: options.projectId,
        clientId: options.clientId,
        service: options.service || "control",
        event: options.event,
        timestamp: Date.now(),
        durationMs: options.durationMs,
        status: options.status,
        metadata: options.metadata,
    });
}

interface StreamEnvelopeLike {
    type?: string;
    key?: string;
    projectId?: string;
    [key: string]: unknown;
}

function describeStreamFields(fields: Record<string, string>): {
    type?: string;
    projectId?: string;
} {
    try {
        const data = fields.data ? (JSON.parse(fields.data) as StreamEnvelopeLike) : undefined;
        if (data) {
            return {
                type: data.type || data.key,
                projectId: data.projectId,
            };
        }
        return { type: fields.type || fields.key, projectId: fields.projectId };
    } catch {
        return { type: fields.type || fields.key, projectId: fields.projectId };
    }
}

/**
 * Publishes an envelope to a Redis stream while mirroring it into the
 * eval event sink.
 *
 * - Production (EVAL_MODE unset): identical to the previous direct
 *   `redis.xAdd(stream, "*", fields)` behavior.
 * - Eval mode (EVAL_MODE=1): Redis is skipped entirely so runs stay hermetic
 *   and cannot wake live serving/orchestrator pods; the event still lands in
 *   the sink (memory + optional EVAL_EVENT_LOG JSONL).
 */
export async function publishStreamEvent(
    stream: string,
    fields: Record<string, string>,
    context: { runId?: string; projectId?: string } = {},
): Promise<void> {
    const startedAt = Date.now();
    const described = describeStreamFields(fields);
    const evalMode = isEvalMode();

    recordAgentEvent({
        runId: context.runId,
        projectId: context.projectId || described.projectId,
        event: "agent.stream.publish",
        status: "success",
        metadata: { stream, redisSkipped: evalMode, ...described },
    });

    if (evalMode) {
        return;
    }

    try {
        await publish(stream, fields);
    } catch (err) {
        recordAgentEvent({
            projectId: context.projectId || described.projectId,
            event: "agent.stream.publish",
            durationMs: Date.now() - startedAt,
            status: "error",
            metadata: {
                stream,
                error: err instanceof Error ? err.message : String(err),
                ...described,
            },
        });
        console.error(`[events] Failed to publish to ${stream}:`, err);
    }
}
