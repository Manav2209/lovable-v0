import type { Store, Options, ClientRateLimitInfo } from "express-rate-limit";
import { RedisManager } from "shared-redis";

const INCREMENT = `
local hits = redis.call('INCR', KEYS[1])
local ttl = redis.call('PTTL', KEYS[1])
if ttl < 0 then
  redis.call('PEXPIRE', KEYS[1], ARGV[1])
  ttl = tonumber(ARGV[1])
end
return {hits, ttl}
`;
const DECREMENT = `
if tonumber(redis.call('GET', KEYS[1]) or '0') > 0 then
  return redis.call('DECR', KEYS[1])
end
return 0
`;

/** Atomic fixed-window counters shared by every backend replica. */
export class RedisRateLimitStore implements Store {
  localKeys = false;
  private windowMs = 60_000;
  constructor(public prefix: string) {}
  init(options: Options) { this.windowMs = options.windowMs; }
  async increment(key: string): Promise<ClientRateLimitInfo> {
    const redis = await RedisManager.getWriter();
    const reply = await redis.eval(INCREMENT, {
      keys: [this.prefix + key], arguments: [String(this.windowMs)],
    }) as [number, number];
    return { totalHits: Number(reply[0]), resetTime: new Date(Date.now() + Number(reply[1])) };
  }
  async decrement(key: string) {
    const redis = await RedisManager.getWriter();
    await redis.eval(DECREMENT, { keys: [this.prefix + key], arguments: [] });
  }
  async resetKey(key: string) {
    const redis = await RedisManager.getWriter();
    await redis.del(this.prefix + key);
  }
}
