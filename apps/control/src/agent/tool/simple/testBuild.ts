

import { tool } from "langchain";
import * as z from "zod";
import { sendSSEMessage } from "../../../sse";
import type { WorkflowState } from "../../graphs/workflow";
import { getProjectDir, resolveSafePath, runProcess } from "../security";

const testBuildInput = z.object({
  action: z.enum(["build", "test"]),
  cwd: z.string().optional(),
});

export const testBuild = tool(
  async (input: z.infer<typeof testBuildInput>) => {
    const { action, cwd } = testBuildInput.parse(input);
    const projectDir = getProjectDir();
    const workingDir = cwd ? resolveSafePath(projectDir, cwd) : projectDir;

    try {
      const install = await runProcess("bun", ["install"], {
        cwd: workingDir,
        timeoutMs: 3 * 60_000,
      });

      if (install.exitCode !== 0) {
        return {
          success: false,
          error: `Failed to install dependencies before ${action}: ${install.stderr.slice(0, 500)}`,
        };
      }

      const args = action === "build" ? ["run", "build"] : ["run", "test"];
      const build = await runProcess("bun", args, {
        cwd: workingDir,
        timeoutMs: 5 * 60_000,
      });

      return {
        exitCode: build.exitCode,
        stdout: build.stdout,
        stderr: build.stderr,
        timedOut: build.timedOut,
        success: build.success,
        error: build.error,
      };
    } catch (error) {
      return {
        success: false,
        error: `Failed to ${action}: ${(error as Error).message}`,
      };
    }
  },
  {
    name: "testBuild",
    description: "Runs build or test commands.",
    schema: testBuildInput,
  },
);


export async function testBuildNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
  sendSSEMessage(state.clientId, {
    type: "testing",
    message: "Running build test...",
  });

  const result = await testBuild.invoke({ action: "build" });

  if (result.success) {
    sendSSEMessage(state.clientId, {
      type: "test_success",
      message: "Build test passed",
    });
    return { buildStatus: "tested" };
  }

  sendSSEMessage(state.clientId, {
    type: "test_failed",
    message: "Build test failed",
  });

  const errorDetails = result.stderr || result.error || "Test build failed";
  console.log("[testBuildNode] Test build failed with error:", errorDetails.substring(0, 500));

  return {
    buildStatus: "errors",
    buildOutput: errorDetails,
    buildErrors: [{
      type: "test",
      severity: "major",
      message: errorDetails,
      fixable: true
    }],
  };
}