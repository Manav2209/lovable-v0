import http from "node:http";
import {
    PreviewRegister,
    PREVIEW_REGISTER,
    PREVIEW_UNREGISTER,
    slugFromHost,
    toPreviewSlug,
} from "types";
import {
    RedisManager,
    parseStreamFields,
    readGroupLoop,
    StreamGroups,
    publishEnvelope,
} from "shared-redis";
import {
    getRoute,
    listRoutes,
    registerRoute,
    unregisterRoute,
} from "./registry";
import { proxyRequest } from "./proxy";

const PORT = Number(process.env.INGRESS_PORT || process.env.PORT || 8080);
const DOMAIN = process.env.PREVIEW_DOMAIN || "preview.localhost";

function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        req.on("data", (c) => chunks.push(c));
        req.on("end", () => {
            try {
                const raw = Buffer.concat(chunks).toString("utf8");
                resolve(raw ? JSON.parse(raw) : {});
            } catch (e) {
                reject(e);
            }
        });
        req.on("error", reject);
    });
}

function sendJson(
    res: http.ServerResponse,
    status: number,
    body: unknown,
): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
}

async function handleAdmin(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    pathname: string,
): Promise<boolean> {
    if (pathname === "/_ingress/health" && req.method === "GET") {
        sendJson(res, 200, {
            ok: true,
            domain: DOMAIN,
            port: PORT,
            routes: listRoutes().length,
        });
        return true;
    }

    if (pathname === "/_ingress/routes" && req.method === "GET") {
        sendJson(res, 200, { routes: listRoutes() });
        return true;
    }

    if (pathname === "/_ingress/register" && req.method === "POST") {
        try {
            const body = (await readJsonBody(req)) as {
                projectId?: string;
                slug?: string;
                upstream?: string;
            };
            if (!body.projectId || !body.upstream) {
                sendJson(res, 400, {
                    error: "INVALID_REQUEST",
                    message: "projectId and upstream are required",
                });
                return true;
            }
            const slug = body.slug || toPreviewSlug(body.projectId);
            const record = registerRoute({
                projectId: body.projectId,
                slug,
                upstream: body.upstream,
            });
            // Fan-out so other ingress replicas stay in sync (optional)
            await publishEnvelope(PreviewRegister, {
                type: PREVIEW_REGISTER,
                projectId: body.projectId,
                slug,
                payload: body.upstream,
            }).catch(() => {});
            sendJson(res, 201, { success: true, route: record });
        } catch (e) {
            sendJson(res, 400, {
                error: "BAD_JSON",
                message: e instanceof Error ? e.message : String(e),
            });
        }
        return true;
    }

    if (pathname === "/_ingress/unregister" && req.method === "POST") {
        try {
            const body = (await readJsonBody(req)) as {
                projectId?: string;
                slug?: string;
            };
            const slug =
                body.slug ||
                (body.projectId ? toPreviewSlug(body.projectId) : null);
            if (!slug) {
                sendJson(res, 400, {
                    error: "INVALID_REQUEST",
                    message: "slug or projectId required",
                });
                return true;
            }
            unregisterRoute(slug);
            sendJson(res, 200, { success: true, slug });
        } catch (e) {
            sendJson(res, 400, {
                error: "BAD_JSON",
                message: e instanceof Error ? e.message : String(e),
            });
        }
        return true;
    }

    return false;
}

function createServer(): http.Server {
    return http.createServer(async (req, res) => {
        const host = req.headers.host || "";
        const url = new URL(req.url || "/", `http://${host || "localhost"}`);

        if (await handleAdmin(req, res, url.pathname)) {
            return;
        }

        const slug = slugFromHost(host, DOMAIN);
        if (!slug) {
            sendJson(res, 400, {
                error: "INVALID_HOST",
                message: `Host must be {slug}.${DOMAIN}`,
                host,
                example: `http://proj-demo.${DOMAIN}:${PORT}/`,
                routes: listRoutes().map((r) => r.slug),
            });
            return;
        }

        await proxyRequest(req, res, slug);
    });
}

async function listenRegisterStream(): Promise<void> {
    // Extend StreamGroups usage — reuse "serve" style role name via custom role
    await readGroupLoop({
        stream: PreviewRegister,
        group: StreamGroups.ingress,
        readerRole: "ingress",
        handler: async (_id, fields) => {
            const msg = parseStreamFields(fields);
            const projectId = msg.projectId as string | undefined;
            const slug =
                (msg.slug as string | undefined) ||
                (projectId ? toPreviewSlug(projectId) : undefined);
            const upstream =
                typeof msg.payload === "string"
                    ? msg.payload
                    : (msg.upstream as string | undefined);

            if (msg.type === PREVIEW_UNREGISTER && slug) {
                unregisterRoute(slug);
                return;
            }

            if (msg.type === PREVIEW_REGISTER && projectId && slug && upstream) {
                registerRoute({ projectId, slug, upstream });
                return;
            }

            console.warn("[ingress] Ignoring register message:", msg);
        },
    });
}

async function shutdown(signal: string) {
    console.log(`[ingress] ${signal}, shutting down...`);
    try {
        await RedisManager.quitAll();
    } catch {
        /* ignore */
    }
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {
    console.log("Preview ingress starting:", {
        PORT,
        DOMAIN,
        REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
    });

    // Redis is optional for local HTTP-only registration / tests
    const skipRedis = process.env.INGRESS_SKIP_REDIS === "true";
    if (!skipRedis) {
        try {
            await RedisManager.getWriter();
            listenRegisterStream().catch((err) =>
                console.error("[ingress] register stream error:", err),
            );
            console.log("[ingress] Redis register listener started");
        } catch (err) {
            console.warn(
                "[ingress] Redis unavailable; HTTP /_ingress/register still works:",
                err,
            );
        }
    } else {
        console.log("[ingress] INGRESS_SKIP_REDIS=true — HTTP register only");
    }

    const server = createServer();
    server.listen(PORT, "0.0.0.0", () => {
        console.log(`[ingress] Listening on http://0.0.0.0:${PORT}`);
        console.log(
            `[ingress] Preview hosts: http://{slug}.${DOMAIN}:${PORT}`,
        );
        console.log(`[ingress] Health: http://127.0.0.1:${PORT}/_ingress/health`);
    });
}

main().catch((err) => {
    console.error("[ingress] Fatal:", err);
    process.exit(1);
});
