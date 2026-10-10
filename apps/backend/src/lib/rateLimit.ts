import rateLimit, { ipKeyGenerator } from "express-rate-limit";
import type { Request } from "express";
import { RedisRateLimitStore } from "./redisRateLimitStore";

function ipKey(req: Request): string {
    return ipKeyGenerator(req.ip ?? "unknown");
}

/**
 * Per-IP throttle for credential endpoints (login/signup). Stops brute force
 * and credential-stuffing while allowing legitimate use (spec-05 §6).
 */
export const authRateLimiter = rateLimit({
    store: new RedisRateLimitStore("lovable:rate-limit:auth:"),
    windowMs: 15 * 60 * 1000, // 15 minutes
    limit: 20,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: ipKey,
    message: {
        success: false,
        data: null,
        error: "TOO_MANY_REQUESTS",
    },
});

/**
 * Per-account throttle for project creation, which provisions real K8s
 * Deployments (spec-05 §6). Keyed by userId so an authenticated user can't
 * spin up unbounded clusters.
 */
export const projectCreateRateLimiter = rateLimit({
    store: new RedisRateLimitStore("lovable:rate-limit:project-create:"),
    windowMs: 60 * 60 * 1000, // 1 hour
    limit: 10,
    standardHeaders: "draft-8",
    legacyHeaders: false,
    keyGenerator: (req) => req.userId ?? ipKey(req),
    message: {
        success: false,
        data: null,
        error: "TOO_MANY_REQUESTS",
    },
});
