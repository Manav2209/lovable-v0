import "dotenv/config";
import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { authRouter } from "./routes/auth";
import { projectRouter } from "./routes/project";
import { startOrchestratorListener } from "./lib/orchestatorListener";
import { assertEnv } from "./lib/env";
import { RedisManager } from "shared-redis";
import { pool } from "database";

assertEnv(["JWT_SECRET", "DATABASE_URL"]);

const app = express();
let shuttingDown = false;
startOrchestratorListener().catch((err) => {
  console.error("Failed to start orchestrator listener:", err);
});

app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));
app.get("/healthz", (_req, res) => {
  res.status(200).json({ ok: true });
});
app.get("/readyz", async (_req, res) => {
  if (shuttingDown) return res.status(503).json({ ok: false });
  try {
    await Promise.race([
      Promise.all([
        RedisManager.getWriter().then(redis => redis.ping()),
        pool.query("SELECT 1"),
      ]),
      new Promise((_, reject) => {
        const timer = setTimeout(() => reject(new Error("Dependency check timed out")), 2000);
        timer.unref();
      }),
    ]);
    return res.status(200).json({ ok: true });
  } catch {
    return res.status(503).json({ ok: false });
  }
});
app.use(helmet());
app.use(express.json());
app.use(
  cors({
    origin: process.env.FRONTEND_ORIGIN || "http://localhost:5173",
  }),
);
app.use("/api/v1/auth" ,authRouter);
app.use("/api/v1" , projectRouter)

app.use((req: Request, res: Response) => {
  res.status(404).json({
    success: false,
    data: null,
    error: "NOT_FOUND",
  });
});

app.use((err: unknown, _req: Request, res: Response, _next: NextFunction) => {
  const code = (err as { code?: string })?.code;
  const message = (err as { message?: string })?.message ?? "";
  if (code === "23505" || /unique constraint|duplicate key/i.test(message)) {
    return res.status(409).json({
      success: false,
      data: null,
      error: "EMAIL_ALREADY_EXISTS",
    });
  }
  console.error("Unhandled error:", err);
  return res.status(500).json({
    success: false,
    data: null,
    error: process.env.NODE_ENV === "production" ? "INTERNAL_SERVER_ERROR" : message,
  });
});

const port = Number(process.env.PORT ?? 4000);
if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error("Invalid PORT");
const server = app.listen(port, "0.0.0.0", () => {
  console.log(`Backend listening on port ${port}`);
});

async function shutdown(signal: string) {
  if (shuttingDown) return;
  shuttingDown = true;
  console.log(`[backend] ${signal}: draining HTTP connections`);
  const force = setTimeout(() => {
    server.closeAllConnections();
    process.exit(1);
  }, 25_000);
  force.unref();
  await new Promise<void>(resolve => server.close(() => resolve()));
  await Promise.all([RedisManager.quitAll(), pool.end()]);
  clearTimeout(force);
  process.exit(0);
}
process.on("SIGTERM", () => void shutdown("SIGTERM"));
process.on("SIGINT", () => void shutdown("SIGINT"));
