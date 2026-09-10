import "dotenv/config";
import cors from "cors";
import express from "express";
import type { NextFunction, Request, Response } from "express";
import helmet from "helmet";
import { authRouter } from "./routes/auth";
import { projectRouter } from "./routes/project";
import { startOrchestratorListener } from "./lib/orchestatorListener";
import { assertEnv } from "./lib/env";

assertEnv(["JWT_SECRET", "DATABASE_URL"]);

const app = express();
startOrchestratorListener().catch((err) => {
  console.error("Failed to start orchestrator listener:", err);
});

app.set("trust proxy", Number(process.env.TRUST_PROXY ?? 1));
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

app.listen(4000, () => {
  console.log("App is listening on port 4000");
});