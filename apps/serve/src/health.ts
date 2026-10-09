import http from "node:http";

export async function previewResponds(port = Number(process.env.PORT || 3000)): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${port}/`, { signal: AbortSignal.timeout(1500) });
    await response.body?.cancel();
    return response.status >= 200 && response.status < 500;
  } catch { return false; }
}

export function createServingHealthServer(checkPreview = previewResponds): http.Server {
  return http.createServer(async (req, res) => {
    if (req.url === "/healthz") {
      res.writeHead(200).end("ok");
    } else if (req.url === "/readyz") {
      const ready = await checkPreview();
      res.writeHead(ready ? 200 : 503).end(ready ? "ready" : "preview not ready");
    } else res.writeHead(404).end();
  });
}
