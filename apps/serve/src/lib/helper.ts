import { getObject, listObjects } from "r2";
import fs from "fs";
import path from "path";
import { spawn, type ChildProcess } from "node:child_process";
import { PROJECT_FAILED, PROJECT_RUN_FAILED, PROJECT_RUN_SUCCESS, ServingToOrchestator } from "types";
import { redis } from "..";

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


export const serveTheProject = async (
  projectId: string
) => {
  const sharedDir = process.env.SHARED_DIR || "/app/shared";
  const dir = path.join(sharedDir, projectId);

  if (!fs.existsSync(dir)) {
    await redis.xAdd(ServingToOrchestator , "*" , {
      data: JSON.stringify({
        projectId : projectId,
        key: PROJECT_FAILED,
        error: "Project directory not found",
      })
    })
    return false;
  }

  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    await redis.xAdd(ServingToOrchestator , "*" , {
      data: JSON.stringify({
        projectId : projectId,
        key: PROJECT_FAILED,
        error: "package.json not found",
      })
    })
    return false;
  }

  const packageJson = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
  const startScript = packageJson.scripts?.start;
  if (!startScript) {
    await redis.xAdd(ServingToOrchestator , "*" , {
      data: JSON.stringify({
        projectId : projectId,
        key: PROJECT_FAILED,
        error: "No start script in package.json",
      })
    })
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
  
    await redis.xAdd(ServingToOrchestator , "*" , {
      data: JSON.stringify({
        projectId : projectId,
        key: PROJECT_RUN_FAILED,
        error: `Failed to install dependencies (exit code: ${installCode})`,
      })
    })
    return false;
  }

  let scriptName: string;
  if (packageJson.scripts?.start) {
    scriptName = "start";
  } else if (packageJson.scripts?.preview) {
    scriptName = "preview";
  } else {
    scriptName = "preview";
  }

  console.log(
    `Starting server for project ${projectId} on port ${port} with script: ${scriptName}`,
  );

  const proc = spawn("bun", ["run", scriptName], {
    cwd: dir,
    stdio: ["ignore", "pipe", "pipe"],
    detached: false,
    env: { ...process.env, PORT: port.toString() },
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
  await new Promise((resolve) => setTimeout(resolve, 5000));

  const checkProc = spawn("nc", ["-z", "localhost", port.toString()]);
  const checkCode: number = await new Promise((resolve) => {
    checkProc.on("close", resolve);
  });

  if (checkCode === 0) {
    console.log(`Server is running on port ${port} for project ${projectId}`);
    await redis.xAdd(ServingToOrchestator , "*" , {
      data: JSON.stringify({
        projectId : projectId,
        key: PROJECT_RUN_SUCCESS,
        port,
        url: `http://localhost:${port}`
      })
    })

    proc.on("close", async (code) => {
      console.log(`Server process for ${projectId} exited with code ${code}`);
      runningProcesses.delete(projectId);

      if (code !== 0) {

        await redis.xAdd(ServingToOrchestator , "*" , {
          data: JSON.stringify({
            projectId : projectId,
            key: PROJECT_RUN_FAILED,
            error: `Server process exited with code ${code}`,
          })
        })
    
        
      }
    });
    return true;
  } else {
    console.error(
      `Server failed to start on port ${port} for project ${projectId}`,
    );
    proc.kill();
    runningProcesses.delete(projectId);

    await redis.xAdd(ServingToOrchestator , "*" , {
      data: JSON.stringify({
        projectId : projectId,
        key: PROJECT_RUN_FAILED,
        error: `Server did not start on port ${port}`,
      })
    })

    return false;
  }
};