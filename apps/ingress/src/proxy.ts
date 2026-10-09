import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import { getRoute } from "./registry";

const HOP_HEADERS = ["connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

function requestHeaders(req: http.IncomingMessage, target: URL, upgrade = false): http.OutgoingHttpHeaders {
  const headers: http.OutgoingHttpHeaders = { ...req.headers, host: target.host };
  if (!upgrade) {
    const connection = String(req.headers.connection || "").split(",").map(h => h.trim().toLowerCase());
    for (const name of [...HOP_HEADERS, ...connection]) delete headers[name];
  }
  return headers;
}

function targetFor(slug: string, path: string): URL | undefined {
  const route = getRoute(slug);
  if (!route) return undefined;
  // Concatenate onto a fixed upstream: a request path must never replace its authority.
  const target = new URL(route.upstream.replace(/\/$/, "") + (path.startsWith("/") ? path : "/" + path));
  if (target.protocol !== "http:" && target.protocol !== "https:") throw new Error("Invalid upstream protocol");
  return target;
}

function proxyError(res: http.ServerResponse, error: unknown) {
  const code = (error as { code?: string }).code;
  const status = code === "ENOTFOUND" ? 404 : 502;
  if (!res.headersSent) {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: status === 404 ? "PREVIEW_NOT_FOUND" : "BAD_GATEWAY" }));
  } else {
    res.destroy(error instanceof Error ? error : undefined);
  }
}

/** Stream raw bytes with backpressure, cancellation, and intact encoding/cookies. */
export async function proxyRequest(req: http.IncomingMessage, res: http.ServerResponse, slug: string): Promise<void> {
  let target: URL | undefined;
  try { target = targetFor(slug, req.url || "/"); } catch (error) { proxyError(res, error); return; }
  if (!target) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "PREVIEW_NOT_FOUND" }));
    return;
  }
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(target, { method: req.method, headers: requestHeaders(req, target) }, response => {
    upstream.setTimeout(0);
    const headers = { ...response.headers };
    const connection = String(response.headers.connection || "").split(",").map(h => h.trim().toLowerCase());
    for (const name of [...HOP_HEADERS, ...connection]) delete headers[name];
    delete headers["x-frame-options"];
    delete headers["content-security-policy"];
    res.writeHead(response.statusCode || 502, headers);
    response.on("error", error => proxyError(res, error));
    response.pipe(res);
  });
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("Upstream connection timed out")));
  upstream.on("error", error => proxyError(res, error));
  req.on("aborted", () => upstream.destroy());
  res.on("close", () => { if (!res.writableFinished) upstream.destroy(); });
  req.pipe(upstream);
}

/** Forward the HTTP upgrade and then pipe the two TCP streams in both directions. */
export function proxyUpgrade(req: http.IncomingMessage, socket: Duplex, head: Buffer, slug: string): void {
  let target: URL | undefined;
  try { target = targetFor(slug, req.url || "/"); } catch { socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n"); return; }
  if (!target) { socket.end("HTTP/1.1 404 Not Found\r\nConnection: close\r\n\r\n"); return; }
  const transport = target.protocol === "https:" ? https : http;
  const upstream = transport.request(target, { method: req.method, headers: requestHeaders(req, target, true) });
  let upgraded = false;
  upstream.setTimeout(30_000, () => upstream.destroy(new Error("WebSocket handshake timed out")));
  upstream.on("upgrade", (response, remote, remoteHead) => {
    upgraded = true;
    upstream.setTimeout(0);
    remote.setTimeout(0);
    socket.write(`HTTP/1.1 ${response.statusCode} ${response.statusMessage}\r\n`);
    for (let i = 0; i < response.rawHeaders.length; i += 2) {
      socket.write(`${response.rawHeaders[i]}: ${response.rawHeaders[i + 1]}\r\n`);
    }
    socket.write("\r\n");
    if (remoteHead.length) socket.write(remoteHead);
    if (head.length) remote.write(head);
    socket.pipe(remote).pipe(socket);
    socket.on("error", () => remote.destroy());
    remote.on("error", () => socket.destroy());
    socket.on("close", () => remote.destroy());
    remote.on("close", () => socket.destroy());
  });
  upstream.on("response", response => {
    response.resume();
    socket.end(`HTTP/1.1 ${response.statusCode || 502} ${response.statusMessage || "Bad Gateway"}\r\nConnection: close\r\n\r\n`);
  });
  upstream.on("error", () => {
    if (upgraded) socket.destroy();
    else socket.end("HTTP/1.1 502 Bad Gateway\r\nConnection: close\r\n\r\n");
  });
  socket.on("error", () => upstream.destroy());
  socket.on("close", () => upstream.destroy());
  upstream.end();
}
