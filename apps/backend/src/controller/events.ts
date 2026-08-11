import type { Request, Response } from "express";
import { RedisManager } from "shared-redis";
import { agentSseChannel } from "types";
import { db } from "database";
import { projects } from "../../../../packages/database/schema";
import { and, eq } from "drizzle-orm";
import jwt from "jsonwebtoken";

function extractToken(req: Request): string | null {
    const q = req.query.token;
    if (typeof q === "string" && q.length > 0) return q;
    const authHeader = req.headers.authorization;
    if (authHeader?.startsWith("Bearer ")) {
        return authHeader.slice("Bearer ".length);
    }
    return null;
}

export async function projectEvents(req: Request, res: Response) {
    const { projectId } = req.params;
    if (!projectId) {
        return res.status(400).json({
            success: false,
            data: null,
            error: "PROJECT_ID_REQUIRED",
        });
    }

    const token = extractToken(req);
    if (!token) {
        return res.status(401).json({
            success: false,
            data: null,
            error: "UNAUTHORIZED",
        });
    }

    let userId: string;
    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as {
            id?: string;
        };
        userId = decoded.id as string;
        if (!userId) throw new Error("missing user id");
    } catch {
        return res.status(401).json({
            success: false,
            data: null,
            error: "UNAUTHORIZED",
        });
    }

    const project = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, userId)))
        .limit(1);

    if (project.length === 0) {
        return res.status(404).json({
            success: false,
            data: null,
            error: "PROJECT_NOT_FOUND",
        });
    }

    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "Access-Control-Allow-Origin": "*",
    });
    res.write(
        `data: ${JSON.stringify({ type: "connected", clientId: projectId })}\n\n`,
    );

    const channel = agentSseChannel(projectId);
    const writer = await RedisManager.getWriter();
    const subscriber = writer.duplicate();
    await subscriber.connect();

    const onMessage = (message: string) => {
        try {
            res.write(`data: ${message}\n\n`);
        } catch {
            /* client gone */
        }
    };

    await subscriber.subscribe(channel, onMessage);

    const heartbeat = setInterval(() => {
        try {
            res.write(`: ping\n\n`);
        } catch {
            /* ignore */
        }
    }, 15000);

    const cleanup = async () => {
        clearInterval(heartbeat);
        try {
            await subscriber.unsubscribe(channel);
            await subscriber.quit();
        } catch {
            /* ignore */
        }
    };

    req.on("close", () => {
        void cleanup();
    });
    req.on("error", () => {
        void cleanup();
    });
}
