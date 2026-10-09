import { expect, test } from "bun:test";
import http from "node:http";
import { createServingHealthServer, previewResponds } from "./health";

test("supervisor stays alive while the preview transitions between unready and ready", async () => {
  let ready = false;
  const supervisor = createServingHealthServer(async () => ready);
  await new Promise<void>(resolve => supervisor.listen(0, "127.0.0.1", resolve));
  const port = (supervisor.address() as { port: number }).port;
  try {
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(503);
    ready = true;
    expect((await fetch(`http://127.0.0.1:${port}/readyz`)).status).toBe(200);
    ready = false;
    expect((await fetch(`http://127.0.0.1:${port}/healthz`)).status).toBe(200);
  } finally { supervisor.closeAllConnections(); await new Promise<void>(resolve => supervisor.close(() => resolve())); }
});

test("a listening server returning only errors is not a ready preview", async () => {
  let status = 500;
  const server = http.createServer((_req, res) => res.writeHead(status).end());
  await new Promise<void>(resolve => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as { port: number }).port;
  try {
    expect(await previewResponds(port)).toBe(false);
    status = 200;
    expect(await previewResponds(port)).toBe(true);
  } finally { server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
