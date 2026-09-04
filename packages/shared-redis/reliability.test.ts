import { describe, expect, it } from "bun:test";
import type { StreamFields } from "./index";
import { StreamReliability } from "./index";
import type { ConsolidatedRedisClient } from "./index";

type DeadLetterEntry = { stream: string; fields: Record<string, unknown> };

/** In-memory fake Redis client satisfying the consolidated interface. */
class FakeClient {
    acks: string[] = [];
    hincr = new Map<string, number>();
    hdelCalls: string[] = [];
    deadLetters: DeadLetterEntry[] = [];
    xPendingCalls = 0;
    xAutoClaimCalls = 0;
    xPendingResult: unknown = { pending: 0 };
    xAutoClaimMessages: Array<{ id: string; message: StreamFields } | null> = [];

    async xAck(_stream: string, _group: string, id: string): Promise<number> {
        this.acks.push(id);
        return 1;
    }
    async hIncrBy(_key: string, field: string, by: number): Promise<number> {
        const v = (this.hincr.get(field) ?? 0) + by;
        this.hincr.set(field, v);
        return v;
    }
    async hDel(_key: string, field: string): Promise<number> {
        this.hdelCalls.push(field);
        this.hincr.delete(field);
        return 1;
    }
    async xAdd(stream: string, _id: string, fields: Record<string, unknown>): Promise<string> {
        this.deadLetters.push({ stream, fields });
        return "1-0";
    }
    async xPending(): Promise<unknown> {
        this.xPendingCalls += 1;
        return this.xPendingResult;
    }
    async xAutoClaim(): Promise<{
        nextId: string;
        messages: Array<{ id: string; message: StreamFields } | null>;
    }> {
        this.xAutoClaimCalls += 1;
        if (this.xAutoClaimCalls === 1) {
            return { nextId: "0-0", messages: this.xAutoClaimMessages };
        }
        return { nextId: "0-0", messages: [] };
    }
}

function makeReliability(client: FakeClient, maxDeliveries = 3) {
    const r = new StreamReliability(
        { stream: "s", group: "g", consumer: "c-1", maxDeliveries, deadLetterStream: "s:dead" },
        client as unknown as ConsolidatedRedisClient,
    );
    return r;
}

describe("StreamReliability (spec-06 §2 redelivery / dead-letter)", () => {
    it("authorizes (XACKs) a message whose handler succeeds, without dead-lettering", async () => {
        const client = new FakeClient();
        const r = makeReliability(client);
        let handled = 0;

        await r.handleMessage("m-1", { data: "{}" }, async () => {
            handled += 1;
        });

        expect(handled).toBe(1);
        expect(client.acks).toEqual(["m-1"]);
        expect(client.deadLetters).toHaveLength(0);
        expect(client.hincr.get("m-1")).toBeUndefined();
    });

    it("leaves a failing message pending (no ack, no dead-letter) until the retry bound", async () => {
        const client = new FakeClient();
        const r = makeReliability(client);

        await r.handleMessage("m-2", { data: "x" }, async () => {
            throw new Error("boom");
        });

        // attempt 1 < maxDeliveries(3): not acked, not dead-lettered.
        expect(client.acks).toEqual([]);
        expect(client.deadLetters).toHaveLength(0);
        expect(client.hincr.get("m-2")).toBe(1);
    });

    it("dead-letters and acknowledges a message once it exceeds the retry bound", async () => {
        const client = new FakeClient();
        const r = makeReliability(client);

        const failing = async () => {
            throw new Error("boom");
        };

        await r.handleMessage("m-3", { data: "x" }, failing); // attempt 1
        await r.handleMessage("m-3", { data: "x" }, failing); // attempt 2
        await r.handleMessage("m-3", { data: "x" }, failing); // attempt 3 -> dead-letter

        expect(client.deadLetters).toHaveLength(1);
        expect(client.deadLetters[0]!.stream).toBe("s:dead");
        expect(client.deadLetters[0]!.fields._originalId).toBe("m-3");
        expect(client.deadLetters[0]!.fields._attempts).toBe("3");
        expect(client.acks).toContain("m-3");
        // Delivery counter is cleared after dead-lettering.
        expect(client.hdelCalls).toContain("m-3");
    });

    it("does not dead-letter across boundaries when the counter has not reached the bound", async () => {
        const client = new FakeClient();
        const r = makeReliability(client);
        const failing = async () => {
            throw new Error("boom");
        };

        await r.handleMessage("m-4", { data: "x" }, failing); // attempt 1
        await r.handleMessage("m-4", { data: "x" }, failing); // attempt 2
        expect(client.deadLetters).toHaveLength(0);
        expect(client.acks).toEqual([]);
    });

    it("reclaimStale queries XPENDING (observing PEL depth) and redispatches claimed messages", async () => {
        const client = new FakeClient();
        const r = makeReliability(client);

        client.xPendingResult = { pending: 2 };
        client.xAutoClaimMessages = [
            { id: "m-pending", message: { data: '"{\\"type\\":\\"T\\"}"' } },
        ];

        const handled: string[] = [];
        await r.reclaimStale(500, 10, async (id) => {
            handled.push(id);
        });

        expect(client.xPendingCalls).toBeGreaterThan(0);
        expect(client.xAutoClaimCalls).toBeGreaterThan(0);
        // The claimed idle message was re-dispatched and acked.
        expect(handled).toContain("m-pending");
        expect(client.acks).toContain("m-pending");
    });

    it("dead-letters a message claimed multiple times past the bound", async () => {
        const client = new FakeClient();
        const r = makeReliability(client);

        client.xPendingResult = { pending: 1 };
        client.xAutoClaimMessages = [{ id: "m-5", message: { data: "x" } }];

        const failing = async () => {
            throw new Error("boom");
        };

        // Attempt 1 & 2 via direct handling (pending, not acked, not dead-lettered).
        await r.handleMessage("m-5", { data: "x" }, failing);
        await r.handleMessage("m-5", { data: "x" }, failing);

        // Attempt 3 via the reclaim sweep -> dead-letter.
        await r.reclaimStale(500, 10, failing);

        expect(client.deadLetters).toHaveLength(1);
        expect(client.deadLetters[0]!.fields._originalId).toBe("m-5");
        expect(client.acks).toContain("m-5");
    });
});
