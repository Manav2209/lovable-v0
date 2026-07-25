import { createClient } from "redis";
import type { RedisClientType } from "redis";

type RedisRole =
    | "writer"
    | "backend"
    | "control"
    | "serving"
    | "orch"
    | "controlReader"
    | "servingReader";

export class RedisManager {
    private static writer: RedisClientType | null = null;
    private static readers: Map<RedisRole, RedisClientType> = new Map();
    private static connecting: Map<RedisRole, Promise<void>> = new Map();

    private static getOptions() {
        return {
            url: process.env.REDIS_URL || "redis://localhost:6379",
            socket: {
                keepAlive: true,
                reconnectStrategy: (retries: number) => Math.min(retries * 100, 3000),
            },
        };
    }

    // -------- Writer (standard client) --------
    public static async getWriter(): Promise<RedisClientType> {
        if (!this.writer) {
            this.writer = createClient(this.getOptions());
            await this.writer.connect();
            this.writer.on("error", (err) => console.error("[Redis Writer]", err));
        }
        return this.writer;
    }

    // -------- Readers (duplicates) --------
    public static async getReader(role: RedisRole): Promise<RedisClientType> {
        // Check if we already have an open reader for this role
        if (this.readers.has(role)) {
            const client = this.readers.get(role)!;
            if (client.isOpen) {
                return client;
            } else {
                // closed – remove it so we can recreate
                this.readers.delete(role);
            }
        }

        // Prevent concurrent duplicate connection attempts
        if (this.connecting.has(role)) {
            await this.connecting.get(role);
            // After connection, the reader should be in the map
            const client = this.readers.get(role);
            if (client && client.isOpen) {
                return client;
            }
            // If still not open, fall through to recreate
        }

        const writer = await this.getWriter();
        const reader = writer.duplicate();
        const connectPromise = reader.connect();
        //@ts-ignore
        this.connecting.set(role, connectPromise);

        try {
            await connectPromise;
            reader.on("error", (err) =>
                console.error(`[Redis Reader:${role}]`, err)
            );
            this.readers.set(role, reader);
            return reader;
        } finally {
            this.connecting.delete(role);
        }
    }

    // -------- Graceful shutdown --------
    public static async quitAll(): Promise<void> {
        const clients = [this.writer, ...this.readers.values()].filter(
            Boolean
        ) as RedisClientType[];
        await Promise.all(clients.map((c) => c.quit().catch(() => {})));
        this.writer = null;
        this.readers.clear();
    }
}