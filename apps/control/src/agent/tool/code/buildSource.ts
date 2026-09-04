import fs from "fs"
import { tool } from "langchain";
import path from "path";
import * as z from "zod";
import { sendSSEMessage } from "../../../sse";
import { publishStreamEvent } from "../../../events/sink";
import { runProcess, resolveSafePath } from "../security";
import { ControlToOrchestrator, ControlToServing, PROJECT_BUILD_FAILED, PROJECT_BUILD_SUCCESS, PROJECT_FAILED, PROJECT_RUN } from "types";
import type { WorkflowState } from "../../graphs/workflow";

export const buildProjectAndNotifyToRun = async (
  projectId: string,
  jobId?: string
) => {
  const sharedDir = process.env.SHARED_DIR || "/app/shared";

  let dir: string;
  try {
    dir = resolveSafePath(sharedDir, projectId);
  } catch (error) {
    console.error(`Invalid project path: ${error instanceof Error ? error.message : String(error)}`);

    await publishStreamEvent(ControlToOrchestrator, {
      data: JSON.stringify({
        key: PROJECT_FAILED,
        projectId,
        jobId,
        error: "Invalid project directory",
      }),
    })
    return false;
  }

  if (!fs.existsSync(dir)) {
    console.error(`Project directory not found: ${dir}`);
  
    await publishStreamEvent(ControlToOrchestrator, {
      data: JSON.stringify({
        key: PROJECT_FAILED,
        projectId,
        jobId,
        error: "Project directory not found",
      }),
    })
    return false;
  }

  const packageJsonPath = path.join(dir, "package.json");
  if (!fs.existsSync(packageJsonPath)) {
    console.error(`package.json not found: ${packageJsonPath}`);

    await publishStreamEvent(ControlToOrchestrator, {
      data: JSON.stringify({
        key: PROJECT_FAILED,
        projectId,
        jobId,
        error: "package.json not found",
      }),
    })
    return false;
  }

  try {
    const viteReady = fs.existsSync(path.join(dir, "node_modules", "vite"));
    const install = viteReady
      ? { success: true, stderr: "", error: undefined }
      : await runProcess("bun", ["install"], {
          cwd: dir,
          timeoutMs: 8 * 60_000,
        });

    if (!install.success) {
      const installStderr = install.stderr || install.error || "unknown error";
      console.error(`Failed to install dependencies: ${installStderr}`);

      await publishStreamEvent(ControlToOrchestrator, {
        data: JSON.stringify({
          key: PROJECT_FAILED,
          projectId,
          jobId,
          error: `Failed to install dependencies: ${installStderr}`,
        }),
      })
      return false;
    }

    const build = await runProcess("bun", ["run", "build"], {
      cwd: dir,
      timeoutMs: 5 * 60_000,
    });

    if (!build.success) {
      const buildStderr = build.stderr || build.error || "unknown error";
      console.error(`Failed to build project: ${buildStderr}`);

      await publishStreamEvent(ControlToOrchestrator, {
        data: JSON.stringify({
          key: PROJECT_BUILD_FAILED,
          projectId,
          jobId,
          error: `Failed to build project: ${buildStderr}`,
        }),
      })
      return false;
    }

    console.log(`Project ${projectId} build completed successfully`);
    
    
    
    return true;
  } catch (error) {
    console.error(`Build error: ${error instanceof Error ? error.message : String(error)}`);
  
    await publishStreamEvent(ControlToOrchestrator, {
      data: JSON.stringify({
        key: PROJECT_BUILD_FAILED,
        projectId,
        jobId,
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

  // Validate + test already ran `bun run build`. Do not call buildSource here:
  // that tool also publishes PROJECT_BUILD_* to the orchestrator and can steal
  // the in-flight prompt waiter (keyed only by projectId).

  await publishStreamEvent(ControlToServing, {
    data: JSON.stringify({
      type: PROJECT_RUN,
      projectId: state.projectId,
    }),
  })

  sendSSEMessage(state.clientId, {
    type: "app_running",
    message: "Preview start requested",
  });

  return { completed: true };
}
