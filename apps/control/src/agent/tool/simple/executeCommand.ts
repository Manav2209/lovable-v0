import { tool } from "langchain";
import * as z from "zod";
import { getProjectDir, resolveSafePath, runShellCommand } from "../security";

const executeCommandInput = z.object({
    command: z.string(),
    cwd: z.string().optional(),
});

export const executeCommand = tool(async (input: z.infer<typeof executeCommandInput>) => {
    const { command, cwd } = executeCommandInput.parse(input);
    const projectDir = getProjectDir();
    const workingDir = cwd ? resolveSafePath(projectDir, cwd) : projectDir;

    try {
        console.log(`[executeCommand] Running: ${command}`);
        console.log(`[executeCommand] Working dir: ${workingDir}`);

        let modifiedCommand = command;
        if (command.includes('bunx --bun shadcn@latest add')) {
            modifiedCommand = `${command} -y --overwrite`;
        }

        const result = await runShellCommand(modifiedCommand, {
            cwd: workingDir,
            timeoutMs: 2 * 60_000,
        });

        return {
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: result.timedOut,
            success: result.success,
            error: result.error,
        };
    } catch (error) {
        return {
            success: false,
            error: `Failed to execute command: ${(error as Error).message}`,
        };
    }
    },
    {
        name: "executeCommand",
        description: "Executes a shell command in the specified directory.",
        schema: executeCommandInput,
    },
);