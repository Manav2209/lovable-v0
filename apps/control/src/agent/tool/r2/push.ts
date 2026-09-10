
import { putObject } from "r2"
import fs from "fs";
import { tool } from "langchain";
import path from "path";
import * as z from "zod";
import type { WorkflowState } from "../../graphs/workflow";
import { sendSSEMessage } from "../../../sse";
import { publishStreamEvent } from "../../../events/sink";
import { resolveSafePath } from "../security";
import { ControlToServing } from "types";
import { shouldIgnoreFile } from "../simple/getContext";

const BUCKET_NAME = process.env.BUCKET_NAME || "lovable";
const UPLOAD_CONCURRENCY = 8;

const pushCodeInput = z.object({
    projectId: z.string().min(1, "Project ID is required"),
    bucketName: z.string().min(1, "Bucket name is required").optional(),
});

function getAllFiles(dirPath: string, relativeTo: string = dirPath): string[] {
    const files: string[] = [];

    if (!fs.existsSync(dirPath)) {
        return files;
    }

    const items = fs.readdirSync(dirPath);

    for (const item of items) {
        const fullPath = path.join(dirPath, item);
        const stat = fs.statSync(fullPath);

        if (stat.isDirectory()) {
            files.push(...getAllFiles(fullPath, relativeTo));
        } else {
            files.push(path.relative(relativeTo, fullPath));
        }
    }

    return files;
}

async function uploadBatch(
    files: string[],
    projectDir: string,
    projectId: string,
    bucket: string,
): Promise<{ uploaded: number; failed: string[] }> {
    let uploaded = 0;
    const failed: string[] = [];

    for (let i = 0; i < files.length; i += UPLOAD_CONCURRENCY) {
        const batch = files.slice(i, i + UPLOAD_CONCURRENCY);
        const results = await Promise.allSettled(
            batch.map(async (filePath) => {
                const fullFilePath = path.join(projectDir, filePath);
                const fileContent = fs.readFileSync(fullFilePath);
                const r2Key = `${projectId}/${filePath}`;
                await putObject({
                    Bucket: bucket,
                    Key: r2Key,
                    Body: fileContent,
                    ContentType: getContentType(filePath),
                });
                return filePath;
            }),
        );
        for (let j = 0; j < results.length; j++) {
            const r = results[j];
            if (r.status === "fulfilled") {
                uploaded++;
            } else {
                console.error(`Failed to upload ${batch[j]}:`, r.reason);
                failed.push(batch[j]);
            }
        }
    }

    return { uploaded, failed };
}

export const pushFilesToR2 = tool(async (input: z.infer<typeof pushCodeInput>) => {
    const { projectId, bucketName = BUCKET_NAME } = pushCodeInput.parse(input);

    try {
        const sharedDir = process.env.SHARED_DIR || "/app/shared";
        const projectDir = resolveSafePath(sharedDir, projectId);

        if (!fs.existsSync(projectDir)) {
            throw new Error(`Project directory ${projectDir} does not exist`);
        }

        const allFiles = getAllFiles(projectDir);
        const files = allFiles.filter((f) => !shouldIgnoreFile(f));

        if (files.length === 0) {
            throw new Error("No files found in project directory after filtering");
        }

        console.log(
            `[pushFilesToR2] ${files.length} files to upload (${allFiles.length} total, ${allFiles.length - files.length} filtered out)`,
        );

        const { uploaded, failed } = await uploadBatch(
            files,
            projectDir,
            projectId,
            bucketName,
        );

        const newObject = {
            projectId,
            bucketName,
            status: "code_pushed",
            timestamp: new Date().toISOString(),
            filesUploaded: uploaded,
            filesFailed: failed.length,
        };

        await publishStreamEvent(ControlToServing, {
            key: projectId,
            value: JSON.stringify(newObject)
        }, { projectId });

        return {
            success: failed.length === 0,
            message: `Pushed ${uploaded} files to R2 for project ${projectId}${failed.length > 0 ? ` (${failed.length} failed)` : ""}`,
            projectId,
            bucketName,
            filesUploaded: uploaded,
            filesFailed: failed.length,
            failedFiles: failed,
            newObject,
        };
    } catch (error) {
        console.error("Error in pushFilesToR2:", error);
        const errorMessage =
            error instanceof Error ? error.message : String(error);
        return {
            success: false,
            message: `Failed to push files for project ${projectId}: ${errorMessage}`,
            projectId,
            bucketName,
            error: errorMessage,
        };
    }
},
    {
        name: "pushFilesToR2",
        description:
        "Pushes all files from the shared project directory to R2 bucket with projectId prefix.",
        schema: pushCodeInput,
    },
);

function getContentType(filePath: string): string {
    const ext = path.extname(filePath).toLowerCase();

    const contentTypes: Record<string, string> = {
        ".js": "application/javascript",
        ".jsx": "application/javascript",
        ".ts": "application/typescript",
        ".tsx": "application/typescript",
        ".json": "application/json",
        ".html": "text/html",
        ".css": "text/css",
        ".md": "text/markdown",
        ".txt": "text/plain",
        ".png": "image/png",
        ".jpg": "image/jpeg",
        ".jpeg": "image/jpeg",
        ".gif": "image/gif",
        ".svg": "image/svg+xml",
    };

    return contentTypes[ext] || "application/octet-stream";
}


export async function pushNode(state: WorkflowState): Promise<Partial<WorkflowState>> {
    sendSSEMessage(state.clientId, {
        type: "pushing",
        message: "Pushing to storage...",
    });

    const result = await pushFilesToR2.invoke({
        projectId: state.projectId,
    });

    sendSSEMessage(
        state.clientId, {
        type: "pushed",
        message: result.success ? "Pushed to storage" : "Push failed",
    }
    );

    if (!result.success) {
        return { error: result.error || result.message };
    }

    return {};
}
