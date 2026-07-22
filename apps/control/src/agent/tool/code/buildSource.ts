import fs from "fs"
import { tool } from "langchain";
import path from "path";
import * as z from "zod";
import { spawn } from "node:child_process";
import { sendSSEMessage } from "../../../sse";
import { redis } from "../../../index";
import { ControlToOrchestator, ControlToServing, PROJECT_BUILD_FAILED, PROJECT_BUILD_SUCCESS, PROJECT_FAILED, PROJECT_RUN } from "types";
import type { WorkflowState } from "../../graphs/workflow";

export const buildProjectAndNotifyToRun = async (
  projectId: string
) => {
  const sharedDir = process.env.SHARED_DIR || "/app/shared";
  const dir = path.join(sharedDir, projectId);

  if (!fs.existsSync(dir)) {
    console.error(`Project directory not found: ${dir}`);
  
    await redis.xAdd(ControlToOrchestator , "*", {
      data: JSON.stringify({
        key: PROJECT_FAILED,
        projectId,
        error: "Project directory not found",
      }),
    })
    return false;
  }

  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    console.error(`package.json not found: ${packageJsonPath}`);

    await redis.xAdd(ControlToOrchestator , "*" ,  {
      data: JSON.stringify({
        key: PROJECT_FAILED,
        projectId,
        error: "package.json not found",
      }),
    })
    return false;
  }

  try {
    const installProc = spawn("bun", ["install"], { cwd: dir });

    let installStderr = "";
    installProc.stderr.on("data", (chunk) => {
      installStderr += chunk.toString();
    });

    const installCode = await new Promise((resolve) => {
      installProc.on("close", (code) => resolve(code));
      installProc.on("error", () => resolve(1));
    });

    if (installCode !== 0) {
      console.error(`Failed to install dependencies: ${installStderr}`);
      

      await redis.xAdd(ControlToOrchestator , "*" ,  {
        data: JSON.stringify({
          key: PROJECT_FAILED,
          projectId,
          error: `Failed to install dependencies: ${installStderr}`,
        }),
      })
      return false;
    }

    const buildProc = spawn("bun", ["run", "build"], { cwd: dir });
    let buildStderr = "";
    buildProc.stderr.on("data", (chunk) => {
      buildStderr += chunk.toString();
    });

    const buildCode = await new Promise((resolve) => {
      buildProc.on("close", (code) => resolve(code));
      buildProc.on("error", () => resolve(1));
    });

    if (buildCode !== 0) {
      console.error(`Failed to build project: ${buildStderr}`);

      await redis.xAdd(ControlToOrchestator , "*" ,  {
        data: JSON.stringify({
          key: PROJECT_BUILD_FAILED,
          projectId,
          error: `Failed to build project: ${buildStderr}`,
        }),
      })
      return false;
    }

    console.log(`Project ${projectId} build completed successfully`);
    
    await redis.xAdd(ControlToOrchestator , "*" ,  {
      data: JSON.stringify({
        key: PROJECT_BUILD_SUCCESS,
        projectId,
        
      }),
    })
    
    return true;
  } catch (error) {
    console.error(`Build error: ${error instanceof Error ? error.message : String(error)}`);
  
    await redis.xAdd(ControlToOrchestator , "*" , {
      data: JSON.stringify({
        key: PROJECT_BUILD_FAILED,
        projectId,
        error: `Build error: ${error instanceof Error ? error.message : String(error)}`,
      }),
    })
    return false;
  }
};

const buildSourceInput = z.object({
  projectId: z.string().min(1, "Project ID is required"),
});

export const buildSource = tool(
  async (input: z.infer<typeof buildSourceInput>) => {
    const { projectId } = buildSourceInput.parse(input);

    const success = await buildProjectAndNotifyToRun(projectId);

    return {
      success,
      projectId,
      message: success ? "Project built successfully" : "Project build failed",
    };
  },
  {
    name: "buildSource",
    description:
      "Builds the project by installing dependencies and running the build script, then notifies the orchestrator about the build status.",
    schema: buildSourceInput,
  },
);


export async function runNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  sendSSEMessage(state.clientId, {
    type: "running",
    message: "Running application...",
  });

  await buildSource.invoke({ projectId: state.projectId });

  await redis.xAdd(ControlToServing , "*" , {
    key: state.projectId,
    data: JSON.stringify({
      key: PROJECT_RUN,
      projectId: state.projectId,
    }),
  })

  sendSSEMessage(state.clientId, {
    type: "completed",
    message: "Workflow completed successfully",
  });

  return { completed: true };
}
