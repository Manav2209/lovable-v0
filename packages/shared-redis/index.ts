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
    } = options;
    const consumer = options.consumer ?? defaultConsumerName(group);

    const deliveriesKey = `stream:${stream}:deliveries`;

    await ensureConsumerGroup(stream, group, startId);
    const reader = await RedisManager.getReader(readerRole);

    console.log(
        `[Redis] Listening on ${stream} as group=${group} consumer=${consumer} (maxDeliveries=${maxDeliveries})`,
    );

    async function deliveryCount(msgId: string): Promise<number> {
        const v = await reader.hIncrBy(deliveriesKey, msgId, 1);
        return v;
    }

    async function clearDelivery(msgId: string): Promise<void> {
        await reader.hDel(deliveriesKey, msgId);
    }

    async function deadLetter(
        msgId: string,
        fields: StreamFields,
        attempts: number,
    ): Promise<void> {
        try {
            await reader.xAdd(deadLetterStream, "*", {
                ...fields,
                data: fields.data
                    ? `${String(fields.data).slice(0, 2000)}`
                    : "",
                _originalId: msgId,
                _deadLetterAt: Date.now().toString(),
                _attempts: String(attempts),
            });
            console.warn(
                `[Redis] ${stream} id=${msgId} exceeded ${maxDeliveries} deliveries; moved to ${deadLetterStream}`,
            );
        } catch (err) {
            console.error(
                `[Redis] Failed writing dead-letter for ${stream} id=${msgId}:`,
                err,
            );
        }
    }

    async function handleMessage(msgId: string, fields: StreamFields) {
        try {
            await handler(msgId, fields);
            await reader.xAck(stream, group, msgId);
        } catch (err) {
            const attempts = await deliveryCount(msgId);
            console.error(
                `[Redis] Handler failed for ${stream} id=${msgId} (attempt ${attempts}):`,
                err,
            );
            if (attempts >= maxDeliveries) {
                await deadLetter(msgId, fields, attempts);
                await reader.xAck(stream, group, msgId);
                await clearDelivery(msgId);
            }
            // Otherwise leave pending; it is reclaimed after claimIdleMs.
        }
    }

    /**
     * Reclaim and re-run pending messages that have been idle for claimIdleMs,
     * covering messages left pending by a previous run or a crashed consumer.
     * Also logs the PEL depth so a growing backlog stays observable.
     */
    async function reclaimStale(): Promise<void> {
        let start = "0-0";
        try {
            const pending = (await reader.xPending(stream, group)) as unknown as {
                pending: number;
            };
            if (pending && typeof pending.pending === "number" && pending.pending > 0) {
                console.log(
                    `[Redis] PEL depth ${stream}:${group} = ${pending.pending}`,
                );
            }

            for (;;) {
                const res = (await reader.xAutoClaim(
                    stream,
                    group,
                    consumer,
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
                    if (m) await handleMessage(m.id, m.message);
                }
                start = res.nextId;
                if (!res.nextId || res.nextId === "0-0") break;
            }
        } catch (err) {
            console.error(
                `[Redis] reclaimStale error on ${stream} (group=${group}):`,
                err,
            );
        }
    }

    let lastClaimAt = 0;

    while (true) {
        try {
            const reply = (await reader.xReadGroup(
                group,
                consumer,
                [{ key: stream, id: ">" }],
                { BLOCK: blockMs, COUNT: count },
            )) as RawStreamReply;

            const messages = extractMessages(reply);
            for (const msg of messages) {
                await handleMessage(msg.id, msg.message);
            }

            // Periodically sweep stale pending messages for redelivery.
            const now = Date.now();
            if (now - lastClaimAt >= claimIntervalMs) {
                lastClaimAt = now;
                await reclaimStale();
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
