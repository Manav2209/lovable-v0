import { createClient } from "redis";
import type { RedisClientType } from "redis";
import { hostname } from "node:os";

type RedisRole =
    | "writer"
    | "backend"
    | "control"
    | "serving"
    | "orch"
    | "controlReader"
    | "servingReader"
    | "orchBackend"
    | "orchControl"
    | "orchServing"
    | "backendOrch"
    | "controlOrch"
    | "controlServing"
    | "serveControl"
    | "serveOrch"
    | "ingress";

export type StreamFields = Record<string, string>;

/**
 * The subset of the node-redis client used by stream redelivery/dead-letter
 * handling. Injected (rather than always pulled from RedisManager) so the
 * reliability logic in `StreamReliability` is unit-testable without a live
 * Redis server (spec-06 §3).
 */
export type ConsolidatedRedisClient = Pick<
    RedisClientType,
    | "xReadGroup"
    | "xAck"
    | "hIncrBy"
    | "hDel"
    | "xAdd"
    | "xPending"
    | "xAutoClaim"
>;

export type StreamMessageHandler = (
    id: string,
    fields: StreamFields,
) => Promise<void> | void;

export type StreamEnvelope = {
    type: string;
    projectId?: string;
    payload?: unknown;
    jobId?: string;
    userId?: string;
    success?: string;
    [key: string]: unknown;
};

type ReadGroupLoopOptions = {
    stream: string;
    group: string;
    consumer?: string;
    readerRole: RedisRole;
    handler: StreamMessageHandler;
    blockMs?: number;
    count?: number;
    backoffMs?: number;
    /** Stream ID to start from when creating the group. Default "$" (new messages only). */
    startId?: "$" | "0";
    /**
     * Max delivery attempts before a message is routed to the dead-letter
     * stream (spec-06 §2). Default 3.
     */
    maxDeliveries?: number;
    /**
     * Min idle time (ms) before a pending message is reclaimed for redelivery
     * via XAUTOCLAIM (spec-06 §2). Default 10000.
     */
    claimIdleMs?: number;
    /**
     * How often (ms) to run the stale-pending reclaim sweep. Default 5000.
     */
    claimIntervalMs?: number;
    /** Dead-letter stream; defaults to `${stream}:dead`. */
    deadLetterStream?: string;
    /**
     * Optional pre-connected Redis client used for reading/acking. When omitted
     * (normal production path), a reader client is obtained from RedisManager
     * by `readerRole`. Supplied directly by tests.
     */
    client?: ConsolidatedRedisClient;
};

export class RedisManager {
    private static writer: RedisClientType | null = null;
    private static readers: Map<RedisRole, RedisClientType> = new Map();
    private static connecting: Map<RedisRole, Promise<void>> = new Map();

    private static getOptions() {
        return {
            url: process.env.REDIS_URL || "redis://localhost:6379",
            socket: {
                keepAlive: true,
                reconnectStrategy: (retries: number) =>
                    Math.min(retries * 100, 3000),
            },
        };
    }

    public static async getWriter(): Promise<RedisClientType> {
        if (!this.writer) {
            this.writer = createClient(this.getOptions());
            await this.writer.connect();
            this.writer.on("error", (err) =>
                console.error("[Redis Writer]", err),
            );
        }
        return this.writer;
    }

    public static async getReader(role: RedisRole): Promise<RedisClientType> {
        if (this.readers.has(role)) {
            const client = this.readers.get(role)!;
            if (client.isOpen) {
                return client;
            }
            this.readers.delete(role);
        }

        if (this.connecting.has(role)) {
            await this.connecting.get(role);
            const client = this.readers.get(role);
            if (client && client.isOpen) {
                return client;
            }
        }

        const writer = await this.getWriter();
        const reader = writer.duplicate();
        const connectPromise = reader.connect().then(() => undefined);
        this.connecting.set(role, connectPromise);

        try {
            await connectPromise;
            reader.on("error", (err) =>
                console.error(`[Redis Reader:${role}]`, err),
            );
            this.readers.set(role, reader);
            return reader;
        } finally {
            this.connecting.delete(role);
        }
    }

    public static async quitAll(): Promise<void> {
        const clients = [this.writer, ...this.readers.values()].filter(
            Boolean,
        ) as RedisClientType[];
        await Promise.all(clients.map((c) => c.quit().catch(() => {})));
        this.writer = null;
        this.readers.clear();
    }
}

export function defaultConsumerName(prefix = "c"): string {
    const host =
        process.env.POD_NAME ||
        process.env.HOSTNAME ||
        hostname() ||
        "local";
    return `${prefix}-${host}-${process.pid}`;
}

export async function ensureConsumerGroup(
    stream: string,
    group: string,
    startId: "$" | "0" = "$",
): Promise<void> {
    const client = await RedisManager.getWriter();
    try {
        await client.xGroupCreate(stream, group, startId, { MKSTREAM: true });
        console.log(
            `[Redis] Created consumer group "${group}" on ${stream} (start=${startId})`,
        );
    } catch (err: unknown) {
        const message = err instanceof Error ? err.message : String(err);
        if (message.includes("BUSYGROUP")) {
            return;
        }
        throw err;
    }
}

export async function publish(
    stream: string,
    fields: StreamFields,
): Promise<string> {
    const writer = await RedisManager.getWriter();
    return writer.xAdd(stream, "*", fields);
}

export async function publishEnvelope(
    stream: string,
    envelope: StreamEnvelope,
): Promise<string> {
    return publish(stream, { data: JSON.stringify(envelope) });
}

/**
 * Parse stream message fields.
 * Prefer `{ data: JSON }` envelope; fall back to legacy flat `type` + `payload`.
 */
export function parseStreamFields(fields: StreamFields): StreamEnvelope {
    if (fields.data) {
        const parsed = JSON.parse(fields.data) as StreamEnvelope & {
            key?: string;
        };
        if (!parsed.type && parsed.key) {
            parsed.type = parsed.key;
        }
        return parsed;
    }

    const type = fields.type || fields.key;
    if (type) {
        let payload: unknown = fields.payload ?? fields.error;
        if (typeof fields.payload === "string") {
            try {
                payload = JSON.parse(fields.payload);
            } catch {
                payload = fields.payload;
            }
        }
        return {
            type,
            projectId: fields.projectId,
            jobId: fields.jobId,
            userId: fields.userId,
            payload,
            success: fields.success,
        };
    }

    throw new Error("Unrecognized stream message fields");
}

type RawStreamReply = Array<{
    name: string;
    messages: Array<{ id: string; message: StreamFields }>;
}> | null;

function extractMessages(
    reply: RawStreamReply,
): Array<{ id: string; message: StreamFields }> {
    if (!reply || reply.length === 0) return [];
    return reply[0]?.messages ?? [];
}

export type StreamReliabilityConfig = {
    stream: string;
    group: string;
    consumer: string;
    maxDeliveries: number;
    deadLetterStream: string;
};

/**
 * Encapsulates the spec-06 §2 reliability rules for a consumer group, driven by
 * an injected `ConsolidatedRedisClient`. Kept separate from `readGroupLoop` so
 * the retry/dead-letter behavior is unit-testable with a fake client and no
 * live Redis.
 *
 * Rules:
 *  - A message is XACKed once its handler resolves.
 *  - If the handler throws, a per-message delivery counter is incremented.
 *    Once the counter reaches `maxDeliveries` the message is written to the
 *    dead-letter stream and XACKed; otherwise it is left pending so
 *    `reclaimStale` can pick it up after the idle threshold.
 *  - `reclaimStale` runs XPENDING (logging PEL depth for observability) and an
 *    XAUTOCLAIM sweep, re-dispatching idle pending messages.
 */
export class StreamReliability {
    private readonly deliveriesKey: string;

    constructor(
        private readonly cfg: StreamReliabilityConfig,
        private readonly client: ConsolidatedRedisClient,
    ) {
        this.deliveriesKey = `stream:${cfg.stream}:deliveries`;
    }

    async deliveryCount(msgId: string): Promise<number> {
        return this.client.hIncrBy(this.deliveriesKey, msgId, 1);
    }

    async clearDelivery(msgId: string): Promise<void> {
        await this.client.hDel(this.deliveriesKey, msgId);
    }

    async deadLetter(
        msgId: string,
        fields: StreamFields,
        attempts: number,
    ): Promise<void> {
        try {
            await this.client.xAdd(this.cfg.deadLetterStream, "*", {
                ...fields,
                data: fields.data ? `${String(fields.data).slice(0, 2000)}` : "",
                _originalId: msgId,
                _deadLetterAt: Date.now().toString(),
                _attempts: String(attempts),
            });
            console.warn(
                `[Redis] ${this.cfg.stream} id=${msgId} exceeded ${this.cfg.maxDeliveries} deliveries; moved to ${this.cfg.deadLetterStream}`,
            );
        } catch (err) {
            console.error(
                `[Redis] Failed writing dead-letter for ${this.cfg.stream} id=${msgId}:`,
                err,
            );
        }
    }

    /**
     * Process a single message: run the handler, XACK on success; on handler
     * failure increment the delivery count and dead-letter + XACK once the
     * retry bound is hit (otherwise leave pending for reclaim).
     */
    async handleMessage(
        msgId: string,
        fields: StreamFields,
        handler: StreamMessageHandler,
    ): Promise<void> {
        try {
            await handler(msgId, fields);
            await this.client.xAck(this.cfg.stream, this.cfg.group, msgId);
        } catch (err) {
            const attempts = await this.deliveryCount(msgId);
            console.error(
                `[Redis] Handler failed for ${this.cfg.stream} id=${msgId} (attempt ${attempts}):`,
                err,
            );
            if (attempts >= this.cfg.maxDeliveries) {
                await this.deadLetter(msgId, fields, attempts);
                await this.client.xAck(this.cfg.stream, this.cfg.group, msgId);
                await this.clearDelivery(msgId);
            }
            // Otherwise leave pending; it is reclaimed after claimIdleMs.
        }
    }

    /**
     * Claim and re-run pending messages idle for `claimIdleMs`, covering
     * messages left pending by a crash or a previous run. Also logs PEL depth.
     */
    async reclaimStale(
        claimIdleMs: number,
        count: number,
        handler: StreamMessageHandler,
    ): Promise<void> {
        let start = "0-0";
        try {
            const pending = (await this.client.xPending(
                this.cfg.stream,
                this.cfg.group,
            )) as unknown as { pending: number };
            if (
                pending &&
                typeof pending.pending === "number" &&
                pending.pending > 0
            ) {
                console.log(
                    `[Redis] PEL depth ${this.cfg.stream}:${this.cfg.group} = ${pending.pending}`,
                );
            }

            for (;;) {
                const res = (await this.client.xAutoClaim(
                    this.cfg.stream,
                    this.cfg.group,
                    this.cfg.consumer,
                    claimIdleMs,
                    start,
                    { COUNT: count },
                )) as unknown as {
                    nextId: string;
                    messages: Array<
                        | { id: string; message: StreamFields }
                        | null
                    >;
                };
                for (const m of res.messages) {
                    if (m) await this.handleMessage(m.id, m.message, handler);
                }
                start = res.nextId;
                if (!res.nextId || res.nextId === "0-0") break;
            }
        } catch (err) {
            console.error(
                `[Redis] reclaimStale error on ${this.cfg.stream} (group=${this.cfg.group}):`,
                err,
            );
        }
    }
}

export async function readGroupLoop(
    options: ReadGroupLoopOptions,
): Promise<never> {
    const {
        stream,
        group,
        readerRole,
        handler,
        blockMs = 5000,
        count = 10,
        backoffMs = 1000,
        startId = "$",
        maxDeliveries = 3,
        claimIdleMs = 10_000,
        claimIntervalMs = 5_000,
        deadLetterStream = `${stream}:dead`,
        client: injectedClient,
    } = options;
    const consumer = options.consumer ?? defaultConsumerName(group);

    await ensureConsumerGroup(stream, group, startId);
    const client: ConsolidatedRedisClient =
        injectedClient ?? (await RedisManager.getReader(readerRole));

    const reliability = new StreamReliability(
        { stream, group, consumer, maxDeliveries, deadLetterStream },
        client,
    );

    console.log(
        `[Redis] Listening on ${stream} as group=${group} consumer=${consumer} (maxDeliveries=${maxDeliveries})`,
    );

    let lastClaimAt = 0;

    while (true) {
        try {
            const reply = (await client.xReadGroup(
                group,
                consumer,
                [{ key: stream, id: ">" }],
                { BLOCK: blockMs, COUNT: count },
            )) as RawStreamReply;

            const messages = extractMessages(reply);
            for (const msg of messages) {
                await reliability.handleMessage(
                    msg.id,
                    msg.message,
                    handler,
                );
            }

            // Periodically sweep stale pending messages for redelivery.
            const now = Date.now();
            if (now - lastClaimAt >= claimIntervalMs) {
                lastClaimAt = now;
                await reliability.reclaimStale(claimIdleMs, count, handler);
            }
        } catch (err) {
            console.error(`[Redis] readGroupLoop error on ${stream}:`, err);
            await new Promise((resolve) => setTimeout(resolve, backoffMs));
        }
    }
}

/** Group names from the plan */
export const StreamGroups = {
    orch: "orch",
    backend: "backend",
    control: "control",
    serve: "serve",
    ingress: "ingress",
} as const;
