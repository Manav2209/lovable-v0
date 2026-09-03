import fs from "fs";
import { tool } from "langchain";
import * as z from "zod";
import { getProjectDir, resolveSafePath } from "../security";
import { contentHash, countOccurrences, toolFail, toolOk } from "../result";

const replaceInFileInput = z.object({
    filePath: z.string().describe("The path to the file to modify"),
    oldString: z.string().describe("The exact string to find and replace"),
    newString: z.string().describe("The new string to replace with"),
    replaceAll: z.boolean().optional().describe("Replace every match when more than one exists"),
});

export const replaceInFile = tool(async (input: z.infer<typeof replaceInFileInput>) => {
    const { filePath, oldString, newString, replaceAll } = replaceInFileInput.parse(input);
    const fullPath = resolveSafePath(getProjectDir(), filePath);

    try {
        if (!fs.existsSync(fullPath)) {
            return toolFail(`File does not exist: ${filePath}`, { diagnostics: { path: filePath } });
        }

        const content = fs.readFileSync(fullPath, "utf8");
        const matches = countOccurrences(content, oldString);

        if (matches === 0) {
            return toolFail(`String not found in ${filePath}`, { diagnostics: { path: filePath } });
        }
        if (matches > 1 && !replaceAll) {
            return toolFail(
                `Found ${matches} matches in ${filePath}. Pass replaceAll=true or use a unique oldString.`,
                { diagnostics: { path: filePath } },
            );
        }

        const newContent = replaceAll
            ? content.split(oldString).join(newString)
            : content.replace(oldString, newString);
        fs.writeFileSync(fullPath, newContent, "utf8");

        return toolOk(`Replaced ${matches} occurrence(s) in ${filePath}`, {
            data: { changes: matches, hash: contentHash(newContent) },
            changedFiles: [filePath],
        });
    } catch (error) {
        return toolFail(`Failed to replace in file: ${(error as Error).message}`, {
            diagnostics: { path: filePath },
        });
    }
},
{
    name: "patchFile",
    description: "Replace an exact string in a file. Fails on 0 matches, and on >1 matches unless replaceAll is true.",
    schema: replaceInFileInput,
},
);

export const patchFile = replaceInFile;
