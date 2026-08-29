import http from "node:http";
import { getRoute } from "./registry";

function joinUrl(upstream: string, reqUrl: string): string {
    const path = reqUrl || "/";
    return `${upstream}${path.startsWith("/") ? path : `/${path}`}`;
}

/**
 * Reverse-proxy the incoming request to the project's upstream.
 * Supports request body piping and streams the upstream response back.
 */
export async function proxyRequest(
    req: http.IncomingMessage,
    res: http.ServerResponse,
    slug: string,
): Promise<void> {
    const route = getRoute(slug);
    if (!route) {
        res.writeHead(404, { "Content-Type": "application/json" });
        res.end(
            JSON.stringify({
                error: "PREVIEW_NOT_FOUND",
                message: `No upstream registered for host slug "${slug}"`,
                hint: "POST /_ingress/register or publish PREVIEW_REGISTER",
            }),
        );
        return;
    }

    const target = joinUrl(route.upstream, req.url || "/");
    let upstreamUrl: URL;
    try {
        upstreamUrl = new URL(target);
    } catch {
        res.writeHead(502, { "Content-Type": "application/json" });
        res.end(JSON.stringify({ error: "INVALID_UPSTREAM", upstream: route.upstream }));
        return;
    }

    const headers: Record<string, string> = {};
    for (const [key, value] of Object.entries(req.headers)) {
        if (value === undefined) continue;
        if (key.toLowerCase() === "host") continue;
        headers[key] = Array.isArray(value) ? value.join(", ") : value;
    }
    headers.host = upstreamUrl.host;

    try {
        const upstreamRes = await fetch(upstreamUrl, {
            method: req.method,
            headers,
            body:
                req.method === "GET" || req.method === "HEAD"
                    ? undefined
                    : req,
            duplex: "half",
            redirect: "manual",
        } as RequestInit);

        const outHeaders: Record<string, string> = {};
        upstreamRes.headers.forEach((value, key) => {
            if (key.toLowerCase() === "transfer-encoding") return;
            outHeaders[key] = value;
        });
        // Allow embedding previews in the product UI iframe
        outHeaders["x-frame-options"] = "ALLOWALL";
        delete outHeaders["content-security-policy"];

        res.writeHead(upstreamRes.status, outHeaders);
        if (!upstreamRes.body) {
            res.end();
            return;
        }

        const reader = upstreamRes.body.getReader();
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            res.write(value);
        }
        res.end();
    } catch (err) {
        console.error(`[ingress] Proxy error for ${slug} → ${target}:`, err);
        if (!res.headersSent) {
            res.writeHead(502, { "Content-Type": "application/json" });
        }
        res.end(
            JSON.stringify({
                error: "BAD_GATEWAY",
                slug,
                upstream: route.upstream,
                message: err instanceof Error ? err.message : String(err),
            }),
        );
    }
}
