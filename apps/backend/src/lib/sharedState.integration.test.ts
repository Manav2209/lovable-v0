import { afterAll, describe, expect, test } from "bun:test";
import { randomUUID, createHash } from "node:crypto";
import { resolve } from "node:path";
import { RedisManager } from "shared-redis";
import { ResponseManager } from "./responseManager";
import { RedisRateLimitStore } from "./redisRateLimitStore";
import { mintSseTicket, redeemSseTicket } from "./sseTicket";
import type { Options } from "express-rate-limit";

const testRedisUrl = process.env.TEST_REDIS_URL;
if (testRedisUrl) process.env.REDIS_URL = testRedisUrl;
const suite = testRedisUrl ? describe : describe.skip;
const keys: string[] = [];
const jobKey = (job: string) => `lovable:job:${job}:responses`;
const ticketKey = (ticket: string) => `lovable:sse-ticket:${createHash("sha256").update(ticket).digest("hex")}`;

async function replica(...args: string[]) {
  const child = Bun.spawn([process.execPath, resolve(import.meta.dir, "../../test/replicaProbe.ts"), ...args], {
    env: { ...process.env, REDIS_URL: testRedisUrl! }, stdout: "pipe", stderr: "pipe",
  });
  const timer = setTimeout(() => child.kill(), 8000);
  try {
    const text = await new Response(child.stdout).text();
    expect(await child.exited).toBe(0);
    return JSON.parse(text.trim());
  } finally { clearTimeout(timer); }
}

suite("shared backend state with an isolated Redis", () => {
  afterAll(async () => {
    const redis = await RedisManager.getWriter();
    if (keys.length) await redis.del(keys);
    await RedisManager.quitAll();
  });

  test("a different process can complete a waiting job", async () => {
    const id = randomUUID(); keys.push(jobKey(id));
    const waiter = new ResponseManager().wait(id, 5000, ["DONE"]);
    await replica("resolve", id, "DONE");
    expect(JSON.parse(await waiter).payload).toBe("from another process");
  }, 10_000);

  test("a fast response survives until the HTTP waiter starts and types do not overwrite one another", async () => {
    const id = randomUUID(); keys.push(jobKey(id));
    await replica("resolve", id, "DONE");
    await new ResponseManager().resolve(id, JSON.stringify({ type: "UNRELATED", payload: "ignore" }));
    expect(JSON.parse(await new ResponseManager().wait(id, 1000, ["DONE"])).type).toBe("DONE");
    const redis = await RedisManager.getWriter();
    expect(await redis.ttl(jobKey(id))).toBeGreaterThan(0);
  }, 10_000);

  test("waiting for another job/type times out and cleans up the local waiter count", async () => {
    const manager = new ResponseManager();
    await expect(manager.wait(randomUUID(), 20, ["DONE"])).rejects.toThrow("TIMEOUT");
    expect(manager.getActiveChannelsCount()).toBe(0);
  });

  test("SSE tickets mint and redeem across processes and can reconnect until expiry", async () => {
    const { ticket } = await replica("mint", "project-a", "user-a"); keys.push(ticketKey(ticket));
    expect(await redeemSseTicket(ticket)).toEqual({ projectId: "project-a", userId: "user-a" });
    expect(await replica("redeem", ticket)).toEqual({ projectId: "project-a", userId: "user-a" });
    const redis = await RedisManager.getWriter();
    await redis.pExpire(ticketKey(ticket), 1);
    await Bun.sleep(10);
    expect(await redeemSseTicket(ticket)).toBeNull();
    expect(await redeemSseTicket("invalid")).toBeNull();
  }, 15_000);

  test("rate-limit counters are shared and atomic, use separate namespaces, and expire", async () => {
    const prefix = `lovable:test-rate:${randomUUID()}:`;
    keys.push(prefix + "user", prefix + "other:user");
    const a = new RedisRateLimitStore(prefix), b = new RedisRateLimitStore(prefix);
    a.init({ windowMs: 1000 } as Options); b.init({ windowMs: 1000 } as Options);
    const values = await Promise.all(Array.from({ length: 20 }, (_, i) => (i % 2 ? a : b).increment("user")));
    expect(values.map(v => v.totalHits).sort((a, b) => a - b)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
    expect((await new RedisRateLimitStore(prefix + "other:").increment("user")).totalHits).toBe(1);
    const redis = await RedisManager.getWriter();
    expect(await redis.pTTL(prefix + "user")).toBeGreaterThan(0);
    await b.decrement("user");
    expect((await a.increment("user")).totalHits).toBe(20);
    await redis.pExpire(prefix + "user", 1);
    await Bun.sleep(10);
    expect((await b.increment("user")).totalHits).toBe(1);
    await a.resetKey("user");
    expect(await redis.exists(prefix + "user")).toBe(0);
  });
});
