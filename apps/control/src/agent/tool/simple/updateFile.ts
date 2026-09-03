import fs from "fs";
import { tool } from "langchain";
import * as z from "zod";
import { getProjectDir, resolveSafePath } from "../security";
import { contentHash, toolFail, toolOk } from "../result";

const updateFileInput = z.object({
    filePath: z.string(),
    content: z.string(),
    expectedHash: z.string().describe("Hash returned by readFile for the current file contents"),
});

export const updateFile = tool(
    async (input: z.infer<typeof updateFileInput>) => {
        const { filePath, content, expectedHash } = updateFileInput.parse(input);
        const fullPath = resolveSafePath(getProjectDir(), filePath);

    try {
        if (!fs.existsSync(fullPath)) {
            return toolFail("File does not exist", { diagnostics: { path: filePath } });
        }
        const current = fs.readFileSync(fullPath, "utf8");
        const currentHash = contentHash(current);
        if (currentHash !== expectedHash) {
            return toolFail(
                `Hash mismatch for ${filePath}. Re-read the file. expected=${expectedHash} actual=${currentHash}`,
                { diagnostics: { path: filePath }, data: { hash: currentHash } },
            );
        }
        fs.writeFileSync(fullPath, content, "utf8");
        return toolOk(`File updated at ${filePath}`, {
            data: { hash: contentHash(content) },
            changedFiles: [filePath],
        });
    } catch (error) {
        return toolFail(`Failed to update file: ${(error as Error).message}`, {
            diagnostics: { path: filePath },
        });
    }
    },
    {
        name: "updateFile",
        description: "Overwrites an existing file. Requires expectedHash from a prior readFile.",
        schema: updateFileInput,
    },
);
