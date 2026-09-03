import fs from "fs";
import { tool } from "langchain";
import path from "path";
import * as z from "zod";
import { getProjectDir, resolveSafePath } from "../security";
import { contentHash, toolFail, toolOk } from "../result";

const createFileInput = z.object({
    filePath: z.string(),
    content: z.string(),
});

export const createFile = tool(async (input: z.infer<typeof createFileInput>) => {
    const { filePath, content } = createFileInput.parse(input);
    const fullPath = resolveSafePath(getProjectDir(), filePath);

    try {
        if (fs.existsSync(fullPath)) {
            return toolFail(`File already exists: ${filePath}. Use updateFile or patchFile.`, {
                diagnostics: { path: filePath },
            });
        }
        fs.mkdirSync(path.dirname(fullPath), { recursive: true });
        fs.writeFileSync(fullPath, content, "utf8");
        return toolOk(`File created at ${filePath}`, {
            data: { hash: contentHash(content) },
            changedFiles: [filePath],
        });
    } catch (error) {
        return toolFail(`Failed to create file: ${(error as Error).message}`, {
            diagnostics: { path: filePath },
        });
    }
    },
    {
        name: "createFile",
        description: "Creates a new file. Fails if the path already exists.",
        schema: createFileInput,
    },
);
