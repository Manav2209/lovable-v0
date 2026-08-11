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
    } = options;
    const consumer = options.consumer ?? defaultConsumerName(group);

    await ensureConsumerGroup(stream, group, startId);
    const reader = await RedisManager.getReader(readerRole);

    console.log(
        `[Redis] Listening on ${stream} as group=${group} consumer=${consumer}`,
    );

    while (true) {
        try {
            const reply = (await reader.xReadGroup(
                group,
                consumer,
                [{ key: stream, id: ">" }],
                { BLOCK: blockMs, COUNT: count },
            )) as RawStreamReply;

            const messages = extractMessages(reply);
            if (messages.length === 0) continue;

            for (const msg of messages) {
                try {
                    await handler(msg.id, msg.message);
                    await reader.xAck(stream, group, msg.id);
                } catch (err) {
                    console.error(
                        `[Redis] Handler failed for ${stream} id=${msg.id} (left pending):`,
                        err,
                    );
                }
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
