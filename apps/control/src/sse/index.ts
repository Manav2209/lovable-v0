import http from "http";
import { parse } from "url";
import { agentSseChannel } from "types";
import { RedisManager } from "shared-redis";
import { isEvalMode, recordAgentEvent } from "../events/sink";

const SSE_PORT = Number(process.env.SSE_PORT || 3001);
const SSE_HOST = process.env.SSE_HOST || "127.0.0.1";

function corsHeaders(): Record<string, string> {
    const origin = process.env.PREVIEW_URL;
    if (!origin) return {};
    return { "Access-Control-Allow-Origin": origin.replace(/\/+$/, "") };
}

interface SSEClient {
    id: string;
    res: http.ServerResponse;
}

let sseServer: http.Server | null = null;
const clients = new Map<string, SSEClient>();

function buildPublicSseUrl(projectId: string): string {
    const previewUrl = process.env.PREVIEW_URL;
    if (previewUrl) {
        try {
            const u = new URL(previewUrl);
            u.pathname = "/sse";
            u.search = `id=${encodeURIComponent(projectId)}`;
            return u.toString();
        } catch {
            /* fall through */
        }
    }
    return `http://localhost:${SSE_PORT}/sse?id=${encodeURIComponent(projectId)}`;
}

export function startSSEServer(): string {
    if (sseServer) {
        return `http://localhost:${SSE_PORT}/sse`;
    }

    sseServer = http.createServer((req, res) => {
        if (req.method === "OPTIONS") {
            res.writeHead(200, {
                ...corsHeaders(),
                "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
                "Access-Control-Allow-Headers": "Content-Type, Cache-Control, Server-Sent-Events",
            });
            res.end();
            return;
        }

        const { pathname, query } = parse(req.url || "", true);
        if (pathname === "/health" && req.method === "GET") {
            res.writeHead(200, { "Content-Type": "text/plain" });
            res.end("ok");
            return;
        }

        if (pathname === "/sse" && req.method === "GET") {
            const clientId = query.id as string;

            if (!clientId) {
                res.writeHead(400, { "Content-Type": "text/plain" });
                res.end("Missing client ID");
                return;
            }

            res.writeHead(200, {
                "Content-Type": "text/event-stream",
                "Cache-Control": "no-cache",
                Connection: "keep-alive",
                ...corsHeaders(),
            });

            res.write(
                `data: ${JSON.stringify({ type: "connected", clientId })}\n\n`,
            );

            const existing = clients.get(clientId);
            if (existing) {
                try {
                    existing.res.end();
                } catch {
                    /* ignore */
                }
            }

            const client: SSEClient = { id: clientId, res };
            clients.set(clientId, client);

            const detach = () => {
                if (clients.get(clientId)?.res === res) {
                    clients.delete(clientId);
                }
            };
            req.on("close", detach);
            req.on("error", detach);
        } else {
            res.writeHead(404, { "Content-Type": "text/plain" });
            res.end("Not Found");
        }
    });

    sseServer.listen(SSE_PORT, SSE_HOST, () => {
        console.log(`SSE server started on http://${SSE_HOST}:${SSE_PORT}`);
    });

    return `http://localhost:${SSE_PORT}/sse`;
}

async function publishAgentEvent(projectId: string, data: unknown) {
    if (isEvalMode()) return;
    try {
        const redis = await RedisManager.getWriter();
        await redis.publish(agentSseChannel(projectId), JSON.stringify(data));
    } catch (err) {
        console.error(`[sse] Failed to publish agent event for ${projectId}:`, err);
    }
}

export function sendSSEMessage(clientId: string, data: unknown): boolean {
    recordAgentEvent({
        clientId,
        event: "agent.sse.message",
        status: "success",
        metadata: { type: (data as { type?: string })?.type },
    });

    void publishAgentEvent(clientId, data);

    const client = clients.get(clientId);
    if (!client) {
        return false;
    }

    try {
        client.res.write(`data: ${JSON.stringify(data)}\n\n`);
        return true;
    } catch {
        clients.delete(clientId);
        return false;
    }
}

export function closeSSEConnection(clientId: string): void {
    const client = clients.get(clientId);
    if (client) {
        client.res.end();
        clients.delete(clientId);
    }
}

export function getSSEUrl(projectId: string): string {
    return buildPublicSseUrl(projectId);
}

export function getProjectSSEUrl(projectId: string): string {
    return getSSEUrl(projectId);
}

export function closeSSEServer(): void {
    for (const client of clients.values()) {
        try {
            client.res.end();
        } catch {
            /* ignore */
        }
    }
    clients.clear();
    if (sseServer) {
        sseServer.close();
        sseServer = null;
        console.log("SSE server closed");
    }
}
