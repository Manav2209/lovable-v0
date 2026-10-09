import { RedisManager } from "shared-redis";

const RESULT_TTL_SECONDS = 1800;
const POLL_INTERVAL_MS = 200;

/** Results belong to jobs in Redis; an HTTP connection remains on its backend. */
export class ResponseManager {
  private activeWaiters = 0;

  async wait(key: string, timeoutMs: number, expectedTypes?: string[]): Promise<string> {
    const deadline = Date.now() + timeoutMs;
    this.activeWaiters++;
    try {
      const redis = await RedisManager.getWriter();
      do {
        const results = await redis.hGetAll(this.resultKey(key));
        const value = expectedTypes?.length
          ? expectedTypes.map(type => results[type]).find(value => value !== undefined)
          : Object.values(results)[0];
        if (value !== undefined) return value;
        const remaining = deadline - Date.now();
        if (remaining <= 0) break;
        await new Promise(resolve => setTimeout(resolve, Math.min(POLL_INTERVAL_MS, remaining)));
      } while (Date.now() <= deadline);
      throw new Error("TIMEOUT");
    } finally {
      this.activeWaiters--;
    }
  }

  async resolve(key: string, value: string): Promise<void> {
    const { type } = JSON.parse(value) as { type?: string };
    if (!type) throw new Error("Job response is missing its type");
    const redis = await RedisManager.getWriter();
    // Commit the response and its TTL together before the stream message is ACKed.
    await redis.multi()
      .hSet(this.resultKey(key), type, value)
      .expire(this.resultKey(key), RESULT_TTL_SECONDS)
      .exec();
  }

  getActiveChannelsCount() { return this.activeWaiters; }

  private resultKey(key: string) { return `lovable:job:${key}:responses`; }
}

export const responseManager = new ResponseManager();