import http from "node:http";
import { RedisManager } from "shared-redis";

export function startHealthServer() {
  return http.createServer(async (req, res) => {
    if (req.url === "/healthz") return res.writeHead(200).end("ok");
    if (req.url !== "/readyz") return res.writeHead(404).end();
    try {
      await Promise.race([
        RedisManager.getWriter().then(redis => redis.ping()),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error("Redis timeout")), 1500); timer.unref(); }),
      ]);
      res.writeHead(200).end("ready");
    } catch { res.writeHead(503).end("not ready"); }
  }).listen(Number(process.env.HEALTH_PORT || 3003), "0.0.0.0");
}
