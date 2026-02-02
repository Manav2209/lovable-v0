import { createClient } from "redis";
import type { RedisClientType as RedisType} from "redis";

export class RedisManager {
    private static standardClient: RedisType;

    private constructor() {}

    public static  getStandardClient(): RedisType {
        if (!this.standardClient) {
            this.standardClient = createClient({
                url: process.env.REDIS_URL || 'redis://localhost:6379'
            });
            this.standardClient.connect().catch(console.error);
        }
        return this.standardClient;
    }

public static async createSubscriberClient() {
    const base =  this.getStandardClient();

    const sub = base.duplicate();

        sub.on("error", (err: any) => {
        console.error("[redis-subscriber]", err);
        });

    await sub.connect();
    return sub;
    }
}
