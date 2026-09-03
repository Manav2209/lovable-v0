import { tool } from "langchain";
import * as z from "zod";
import { getProjectDir, runProcess } from "../security";
import { toolFail, toolOk } from "../result";

const COMPONENT_RE = /^[a-z][a-z0-9-]*$/;

const addShadcnComponentInput = z.object({
    component: z.string().describe("shadcn component name, e.g. dialog or dropdown-menu"),
});

export const addShadcnComponent = tool(
    async (input: z.infer<typeof addShadcnComponentInput>) => {
        const { component } = addShadcnComponentInput.parse(input);
        if (!COMPONENT_RE.test(component) || component.length > 64) {
            return toolFail(`Invalid shadcn component name: "${component}"`);
        }

        const result = await runProcess(
            "bunx",
            ["--bun", "shadcn@latest", "add", component, "-y", "--overwrite"],
            { cwd: getProjectDir(), timeoutMs: 3 * 60_000 },
        );

        if (!result.success) {
            return toolFail(result.error || result.stderr || "Failed to add shadcn component", {
                data: { stdout: result.stdout, stderr: result.stderr, exitCode: result.exitCode },
            });
        }

        return toolOk(`Added shadcn component ${component}`, {
            data: { stdout: result.stdout },
            changedFiles: [`src/components/ui/${component}.jsx`],
        });
    },
    {
        name: "addShadcnComponent",
        description: "Adds a shadcn/ui component via bunx. Does not run arbitrary shell commands.",
        schema: addShadcnComponentInput,
    },
);
