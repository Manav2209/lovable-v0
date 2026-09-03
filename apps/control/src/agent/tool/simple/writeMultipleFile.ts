import fs from "fs";
import { tool } from "langchain";
import path from "path";
import * as z from "zod";
import { getProjectDir, resolveSafePath } from "../security";
import { toolFail, toolOk } from "../result";

const fileInput = z.object({
    path: z.string(),
    data: z.string(),
});

const writeMultipleFileInput = z.object({
    files: z.array(fileInput),
});

export const writeMultipleFile = tool(async (input: z.infer<typeof writeMultipleFileInput>) => {
    const { files } = writeMultipleFileInput.parse(input);
    const staged: Array<{ tmp: string; dest: string; rel: string }> = [];

    try {
        for (const file of files) {
            const dest = resolveSafePath(getProjectDir(), file.path);
            fs.mkdirSync(path.dirname(dest), { recursive: true });
            const tmp = `${dest}.__agent_tmp`;
            fs.writeFileSync(tmp, file.data, "utf8");
            staged.push({ tmp, dest, rel: file.path });
        }

        const changedFiles: string[] = [];
        for (const item of staged) {
            fs.renameSync(item.tmp, item.dest);
            changedFiles.push(item.rel);
        }

        return toolOk(`Wrote ${changedFiles.length} files`, { changedFiles });
    } catch (error) {
        for (const item of staged) {
            try {
                if (fs.existsSync(item.tmp)) fs.unlinkSync(item.tmp);
            } catch {
                /* ignore */
            }
        }
        return toolFail(`Failed to write files: ${(error as Error).message}`);
    }
    },
    {
        name: "writeMultipleFile",
        description: "Creates or updates multiple files with staged writes, then rename into place.",
        schema: writeMultipleFileInput,
    },
);
