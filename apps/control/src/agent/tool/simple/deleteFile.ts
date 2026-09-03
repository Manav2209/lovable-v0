import fs from "fs";
import { tool } from "langchain";
import * as z from "zod";
import { getProjectDir, resolveSafePath } from "../security";
import { toolFail, toolOk } from "../result";

const deleteFileInput = z.object({
    filePath: z.string(),
});

export const deleteFile = tool(async (input: z.infer<typeof deleteFileInput>) => {
    const { filePath } = deleteFileInput.parse(input);
    const fullPath = resolveSafePath(getProjectDir(), filePath);

    try {
        if (!fs.existsSync(fullPath)) {
            return toolFail("File does not exist", { diagnostics: { path: filePath } });
        }
        fs.unlinkSync(fullPath);
        return toolOk(`File deleted at ${filePath}`, { changedFiles: [filePath] });
    } catch (error) {
        return toolFail(`Failed to delete file: ${(error as Error).message}`, {
            diagnostics: { path: filePath },
        });
    }
    },
    {
        name: "deleteFile",
        description: "Deletes a file at the specified path.",
        schema: deleteFileInput,
    },
);
