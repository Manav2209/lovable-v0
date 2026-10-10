import { afterAll, beforeAll, expect, test } from "bun:test";
import http from "node:http";
import { gzipSync } from "node:zlib";
import { getRoute, registerRoute, unregisterRoute } from "./registry";
import { slugFromHost } from "types";

const oldMode = process.env.INGRESS_ROUTING_MODE;
const oldDomain = process.env.PREVIEW_DOMAIN;
process.env.INGRESS_ROUTING_MODE = "registered";
process.env.PREVIEW_DOMAIN = "preview.test";
const { createServer } = await import("./index");
const gateway = createServer();
let port = 0;

async function listen(server: http.Server): Promise<number> {
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as { port: number }).port;
}

async function close(server: http.Server) {
  server.closeAllConnections();
  await new Promise<void>(resolve => server.close(() => resolve()));
}

function request(path: string, host = "proj-test.preview.test") {
  return new Promise<{ status: number; headers: http.IncomingHttpHeaders; body: Buffer }>((resolve, reject) => {
    const req = http.get({ hostname: "127.0.0.1", port, path, headers: { host } }, res => {
      const chunks: Buffer[] = [];
      res.on("data", chunk => chunks.push(chunk));
      res.on("end", () => resolve({ status: res.statusCode!, headers: res.headers, body: Buffer.concat(chunks) }));
      res.on("error", reject);
    });
    req.on("error", reject);
    req.setTimeout(3000, () => req.destroy(new Error("request timed out")));
  });
}

beforeAll(async () => { port = await listen(gateway); });
afterAll(async () => {
  unregisterRoute("proj-test");
  await close(gateway);
  if (oldMode === undefined) delete process.env.INGRESS_ROUTING_MODE; else process.env.INGRESS_ROUTING_MODE = oldMode;
  if (oldDomain === undefined) delete process.env.PREVIEW_DOMAIN; else process.env.PREVIEW_DOMAIN = oldDomain;
});

test("compressed response bytes, cookies, and request paths survive proxying", async () => {
  const payload = gzipSync("preview content");
  let receivedPath = "";
  let receivedHost = "";
  const upstream = http.createServer((req, res) => {
    receivedPath = req.url!;
    receivedHost = req.headers.host!;
    res.writeHead(200, {
      "content-encoding": "gzip", "content-length": payload.length,
      "set-cookie": ["first=1; Path=/", "second=2; Path=/"],
    }).end(payload);
  });
  const upstreamPort = await listen(upstream);
  registerRoute({ projectId: "test", slug: "proj-test", upstream: `http://127.0.0.1:${upstreamPort}` });
  try {
    // A protocol-relative path must stay on the configured upstream.
    const result = await request("//untrusted.invalid/asset?q=1", "proj-test.preview.test:8080");
    expect(receivedPath).toBe("//untrusted.invalid/asset?q=1");
    expect(receivedHost).toBe("proj-test.preview.test:8080");
    expect(result.body).toEqual(payload);
    expect(result.headers["content-encoding"]).toBe("gzip");
    expect(result.headers["set-cookie"]).toEqual(["first=1; Path=/", "second=2; Path=/"]);
  } finally { await close(upstream); }
});

test("SSE starts streaming without waiting for completion and client cancellation closes upstream", async () => {
  let upstreamClosed!: () => void;
  const closed = new Promise<void>(resolve => { upstreamClosed = resolve; });
  const upstream = http.createServer((_req, res) => {
    res.writeHead(200, { "content-type": "text/event-stream" });
    res.write("data: first\n\n");
    res.on("close", upstreamClosed);
  });
  const upstreamPort = await listen(upstream);
  registerRoute({ projectId: "test", slug: "proj-test", upstream: `http://127.0.0.1:${upstreamPort}` });
  try {
    const firstChunk = await new Promise<string>((resolve, reject) => {
      const req = http.get({ hostname: "127.0.0.1", port, headers: { host: "proj-test.preview.test" } }, res => {
        res.once("data", chunk => { resolve(chunk.toString()); res.destroy(); });
        res.on("error", () => {});
      });
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("SSE did not stream")));
    });
    expect(firstChunk).toBe("data: first\n\n");
    await Promise.race([closed, Bun.sleep(3000).then(() => { throw new Error("upstream was not cancelled"); })]);
  } finally { await close(upstream); }
});

test("WebSocket handshake, path, and frames pass through the gateway", async () => {
  let receivedPath = "";
  let receivedHost = "";
  const upstream = Bun.serve({
    hostname: "127.0.0.1", port: 0,
    fetch(req, server) {
      receivedPath = new URL(req.url).pathname;
      receivedHost = req.headers.get("host")!;
      if (server.upgrade(req)) return;
      return new Response("upgrade required", { status: 426 });
    },
    websocket: { message(ws, message) { ws.send(message); } },
  });
  registerRoute({ projectId: "test", slug: "proj-test", upstream: `http://127.0.0.1:${upstream.port}` });
  try {
    const echoed = await new Promise<string>((resolve, reject) => {
      const req = http.request({ hostname: "127.0.0.1", port, path: "/hmr", headers: {
        host: "proj-test.preview.test", connection: "Upgrade", upgrade: "websocket",
        "sec-websocket-version": "13", "sec-websocket-key": "dGhlIHNhbXBsZSBub25jZQ==",
      } });
      req.on("upgrade", (res, socket, head) => {
        expect(res.statusCode).toBe(101);
        let buffered = head;
        const consume = (chunk: Buffer) => {
          buffered = Buffer.concat([buffered, chunk]);
          if (buffered.length >= 2 && buffered.length >= 2 + (buffered[1]! & 127)) {
            const text = buffered.subarray(2, 2 + (buffered[1]! & 127)).toString();
            socket.destroy(); resolve(text);
          }
        };
        socket.on("data", consume);
        socket.on("error", reject);
        socket.setTimeout(3000, () => { socket.destroy(); reject(new Error("WebSocket echo timed out")); });
        const text = Buffer.from("hot reload");
        const mask = Buffer.from([1, 2, 3, 4]);
        const frame = Buffer.alloc(6 + text.length);
        frame[0] = 0x81; frame[1] = 0x80 | text.length; mask.copy(frame, 2);
        for (let i = 0; i < text.length; i++) frame[6 + i] = text[i]! ^ mask[i % 4]!;
        socket.write(frame);
        consume(Buffer.alloc(0));
      });
      req.on("response", () => reject(new Error("upgrade rejected")));
      req.on("error", reject);
      req.setTimeout(3000, () => req.destroy(new Error("handshake timed out")));
      req.end();
    });
    expect(receivedPath).toBe("/hmr");
    expect(receivedHost).toBe("proj-test.preview.test");
    expect(echoed).toBe("hot reload");
  } finally { await upstream.stop(true); }
});

test("invalid hosts and unknown previews are rejected", async () => {
  expect((await request("/", "unrelated.test")).status).toBe(400);
  expect((await request("/", "proj-nested.evil.preview.test")).status).toBe(400);
  expect((await request("/", "proj-unknown.preview.test")).status).toBe(404);
  expect(slugFromHost("proj-.preview.test", "preview.test")).toBeNull();
});

test("cluster route lookup needs no registration and cannot escape the project namespace", () => {
  process.env.INGRESS_ROUTING_MODE = "cluster";
  const oldNamespace = process.env.K8S_NAMESPACE;
  process.env.K8S_NAMESPACE = "lovable-projects";
  try {
    expect(getRoute("proj-new")?.upstream).toBe("http://proj-new.lovable-projects.svc.cluster.local:80");
    expect(() => getRoute("proj-new.evil")).toThrow("Invalid preview slug");
  } finally {
    process.env.INGRESS_ROUTING_MODE = "registered";
    if (oldNamespace === undefined) delete process.env.K8S_NAMESPACE; else process.env.K8S_NAMESPACE = oldNamespace;
  }
});
