import fs from "fs";
import { tool } from "langchain";
import * as z from "zod";
import { getProjectDir, resolveSafePath } from "../security";
import { contentHash, toolFail, toolOk } from "../result";

const readFileInput = z.object({
    filePath: z.string(),
    startLine: z.number().optional().describe("Starting line number (1-indexed)"),
    endLine: z.number().optional().describe("Ending line number (1-indexed)"),
});

export const readFile = tool(async (input: z.infer<typeof readFileInput>) => {
    const { filePath, startLine, endLine } = readFileInput.parse(input);
    const fullPath = resolveSafePath(getProjectDir(), filePath);

    try {
        const content = fs.readFileSync(fullPath, "utf8");
        const hash = contentHash(content);
        const lines = content.split("\n");
        const totalLines = lines.length;
        const stats = fs.statSync(fullPath);

        if (startLine !== undefined || endLine !== undefined) {
            const start = (startLine || 1) - 1;
            const end = endLine || totalLines;

            if (start < 0 || end > totalLines || start >= end) {
                return toolFail(`Invalid line range: ${startLine}-${endLine}. File has ${totalLines} lines.`, {
                    diagnostics: { path: filePath },
                    data: { hash, totalLines, sizeBytes: stats.size },
                });
            }

            const selectedLines = lines.slice(start, end);
            return toolOk(`Read ${filePath} lines ${startLine || 1}-${endLine || totalLines}`, {
                data: {
                    content: selectedLines.join("\n"),
                    hash,
                    totalLines,
                    returnedLines: selectedLines.length,
                    lineRange: `${startLine || 1}-${endLine || totalLines}`,
                    sizeBytes: stats.size,
                },
            });
        }

        return toolOk(`Read ${filePath}`, {
            data: {
                content,
                hash,
                totalLines,
                sizeBytes: stats.size,
            },
        });
    } catch (error) {
        return toolFail(`Failed to read file: ${(error as Error).message}`, {
            diagnostics: { path: filePath },
        });
    }
},
{
    name: "readFile",
    description: "Reads a file and returns content plus a hash. Pass that hash to updateFile as expectedHash.",
    schema: readFileInput,
},
);
