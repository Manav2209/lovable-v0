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

const MAX_READ_CHARS = 40_000;

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

            let selectedLines = lines.slice(start, end).join("\n");
            const rangeTruncated = selectedLines.length > MAX_READ_CHARS;
            if (rangeTruncated) {
                selectedLines = `${selectedLines.slice(0, MAX_READ_CHARS)}\n... [truncated: ${selectedLines.length} chars returned; use a narrower startLine/endLine range]`;
            }
            return toolOk(`Read ${filePath} lines ${startLine || 1}-${endLine || totalLines}`, {
                data: {
                    content: selectedLines,
                    hash,
                    totalLines,
                    returnedLines: selectedLines.split("\n").length,
                    lineRange: `${startLine || 1}-${endLine || totalLines}`,
                    sizeBytes: stats.size,
                    truncated: rangeTruncated,
                },
            });
        }

        let output = content;
        const truncated = output.length > MAX_READ_CHARS;
        if (truncated) {
            output = `${output.slice(0, MAX_READ_CHARS)}\n... [truncated: ${content.length} chars total; use startLine/endLine to read specific ranges]`;
        }

        return toolOk(`Read ${filePath}`, {
            data: {
                content: output,
                hash,
                totalLines,
                sizeBytes: stats.size,
                truncated,
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
