import { tool } from "langchain";
import * as z from "zod";
import { toolFail } from "../result";

const executeCommandInput = z.object({
    command: z.string(),
    cwd: z.string().optional(),
});

export const executeCommand = tool(async () => {
    return toolFail(
        "executeCommand is disabled. Use addShadcnComponent, addDependency, or file tools instead.",
    );
    },
    {
        name: "executeCommand",
        description: "Disabled. Arbitrary shell execution is not available to the agent.",
        schema: executeCommandInput,
    },
);
