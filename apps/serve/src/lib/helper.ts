import { getObject, listObjects } from "r2";
import fs from "fs";
import path from "path";
import net from "node:net";
import { spawn, type ChildProcess } from "node:child_process";
import { PROJECT_FAILED, PROJECT_RUN_FAILED, ServingToOrchestrator } from "types";
import { publishEnvelope } from "shared-redis";

const runningProcesses = new Map<string, ChildProcess>();

export const fetchFilesFromSharedDir = async (projectId: string) => {
  console.log(`${process.env.SHARED_DIR}`);
  const bucketName = process.env.BUCKET_NAME || "lovable";
  const dir = path.join(
    `${process.env.SHARED_DIR}` || "/app/shared",
    projectId,
  );
  fs.mkdirSync(dir, { recursive: true });

  try {
    const { Contents } = await listObjects({
      Bucket: bucketName,
      Prefix: `${projectId}/`,
    });

    if (!Contents || Contents.length === 0) {
      console.error(`No files found for project ${projectId}`);
      return false;
    }

    for (const obj of Contents) {
      if (!obj.Key) continue;

      if (obj.Key === `${projectId}/`) continue;

      try {
        const { Body } = await getObject({
          Bucket: bucketName,
          Key: obj.Key,
        });

        const relativePath = obj.Key.replace(`${projectId}/`, "");
        const filePath = path.join(dir, relativePath);

        fs.mkdirSync(path.dirname(filePath), { recursive: true });

        const buffer = Buffer.from(
          (await Body?.transformToByteArray()) || new Uint8Array(),
        );
        fs.writeFileSync(filePath, buffer);
      } catch (error) {
        console.error(`Failed to download ${obj.Key}:`, error);
      }
    }

    console.log(
      `Successfully fetched files and confirmed project ${projectId}`,
    );
    return true;
  } catch (error) {
    console.error(
      `Failed to fetch files and confirm project ${projectId}:`,
      error,
    );
    return false;
  }
};

export const checkIfProjectFilesExist = (projectId: string): boolean => {
  const dir = path.join(
    `${process.env.SHARED_DIR}` || "/app/shared",
    projectId,
  );

  return fs.existsSync(dir) && fs.readdirSync(dir).length > 0;
};

/** Prefer start, then Vite-style preview/dev (template has no start script). */
function resolveServeScript(
  scripts: Record<string, string> | undefined,
): string | null {
  if (!scripts) return null;
  if (scripts.start) return "start";
  if (scripts.dev) return "dev";
  if (scripts.preview) return "preview";
  return null;
}

export const serveTheProject = async (projectId: string) => {
  const sharedDir = process.env.SHARED_DIR || "/app/shared";
  const dir = path.join(sharedDir, projectId);

  if (!fs.existsSync(dir)) {
    await publishEnvelope(ServingToOrchestrator, {
      projectId,
      type: PROJECT_FAILED,
      payload: "Project directory not found",
    });
    return false;
  }

  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    await publishEnvelope(ServingToOrchestrator, {
      projectId,
      type: PROJECT_FAILED,
      payload: "package.json not found",
    });
    return false;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const scriptName = resolveServeScript(packageJson.scripts);
  if (!scriptName) {
    await publishEnvelope(ServingToOrchestrator, {
      projectId,
      type: PROJECT_FAILED,
      payload: "No start/dev/preview script in package.json",
    });
    return false;
  }

  const port = 3000;

  try {
    const killCommand = `lsof -ti:${port} | xargs kill -9 2>/dev/null || true`;
    const killProc = spawn(killCommand, [], { shell: true });
    await new Promise((resolve) => killProc.on("close", resolve));
    console.log(`Killed existing process on port ${port}`);
  } catch (error) {
    console.error(`Failed to free port ${port}:`, error);
  }

  const existingProc = runningProcesses.get(projectId);
  if (existingProc) {
    console.log(`Killing existing process for project ${projectId}`);
    existingProc.kill();
    runningProcesses.delete(projectId);
  }

  const nodeModules = path.join(dir, "node_modules");
  if (fs.existsSync(nodeModules)) {
    console.log(
      `Skipping bun install for ${projectId} (node_modules already present)`,
    );
  } else {
    console.log(`Installing dependencies for project ${projectId}`);
    const installProc = spawn("bun", ["install"], { cwd: dir, stdio: "pipe" });

    installProc.stdout?.on("data", (data) =>
      console.log(`[${projectId}] install:`, data.toString()),
    );
    installProc.stderr?.on("data", (data) =>
      console.error(`[${projectId}] install error:`, data.toString()),
    );

    const installCode: number = await new Promise((resolve) =>
      installProc.on("close", resolve),
    );

    if (installCode !== 0) {
      console.error(`Failed to install dependencies for ${projectId}`);

      await publishEnvelope(ServingToOrchestrator, {
        projectId,
        type: PROJECT_RUN_FAILED,
        payload: `Failed to install dependencies (exit code: ${installCode})`,
      });
      return false;
    }
  }

  console.log(
    `Starting server for project ${projectId} on port ${port} with script: ${scriptName}`,
  );

  const hasViteConfig =
    fs.existsSync(path.join(dir, "vite.config.ts")) ||
    fs.existsSync(path.join(dir, "vite.config.js")) ||
    fs.existsSync(path.join(dir, "vite.config.mts"));

  // Force Vite onto the K8s service port (default is 5173).
  const proc = hasViteConfig
    ? spawn(
        "bun",
        [
          "x",
          "vite",
          "--host",
          "0.0.0.0",
          "--port",
          String(port),
          "--strictPort",
        ],
        {
          cwd: dir,
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
          env: {
            ...process.env,
            PORT: port.toString(),
            HOST: "0.0.0.0",
          },
        },
      )
    : spawn("bun", ["run", scriptName], {
        cwd: dir,
        stdio: ["ignore", "pipe", "pipe"],
        detached: false,
        env: {
          ...process.env,
          PORT: port.toString(),
          HOST: "0.0.0.0",
        },
      });

  runningProcesses.set(projectId, proc);

  proc.stdout?.on("data", (data) => {
    console.log(`[${projectId}] stdout:`, data.toString());
  });

  proc.stderr?.on("data", (data) => {
    console.error(`[${projectId}] stderr:`, data.toString());
  });

  proc.on("error", (error) => {
    console.error(`[${projectId}] Process error:`, error);
  });

  console.log(`Waiting for server to start on port ${port}...`);
  const ready = await waitForPort(port, 60_000);
  if (ready) {
    console.log(`Server is running on port ${port} for project ${projectId}`);

    proc.on("close", async (code) => {
      console.log(`Server process for ${projectId} exited with code ${code}`);
      runningProcesses.delete(projectId);

      if (code !== 0 && code !== 143) {
        await publishEnvelope(ServingToOrchestrator, {
          projectId,
          type: PROJECT_RUN_FAILED,
          payload: `Server process exited with code ${code}`,
        });
      }
    });
    return true;
  }

  console.error(
    `Server failed to start on port ${port} for project ${projectId}`,
  );
  proc.kill();
  runningProcesses.delete(projectId);

  await publishEnvelope(ServingToOrchestrator, {
    projectId,
    type: PROJECT_RUN_FAILED,
    payload: `Server did not start on port ${port}`,
  });

  return false;
};

async function waitForPort(port: number, timeoutMs: number): Promise<boolean> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    // Prefer HTTP — Vite may accept TCP before it's ready to serve.
    try {
      const res = await fetch(`http://127.0.0.1:${port}/`, {
        method: "GET",
        signal: AbortSignal.timeout(2000),
      });
      // Any HTTP response means the server is up (including 404).
      if (res.status >= 100) return true;
    } catch {
      /* not ready yet */
    }

    try {
      const ok = await new Promise<boolean>((resolve) => {
        const socket = net.connect({ host: "127.0.0.1", port }, () => {
          socket.end();
          resolve(true);
        });
        socket.on("error", () => resolve(false));
        socket.setTimeout(1500, () => {
          socket.destroy();
          resolve(false);
        });
      });
      if (ok) return true;
    } catch {
      /* ignore */
    }

    await new Promise((r) => setTimeout(r, 1000));
  }
  return false;
}
