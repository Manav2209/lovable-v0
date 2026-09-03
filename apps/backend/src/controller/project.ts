import { createProjectSchema } from "../lib/schema";
import { db } from "database";
import {
    conversationHistory,
    projects,
} from "../../../../packages/database/schema";
import { createRandomJobId, publishToStream } from "../lib/helper";
import {
    BackendToOrchestator,
    CREATE_PROJECT,
    PROJECT_FAILED,
    PROJECT_INITIALIZED,
    PROMPT,
    PROMPT_RESPONSE,
} from "types";
import { eq, and, desc, asc } from "drizzle-orm";
import { responseManager } from "../lib/responseManager";
import type { Request, Response } from "express";

export const createProject = async (req: Request, res: Response) => {
    const { success, data } = createProjectSchema.safeParse(req.body);

    if (!success) {
        return res.status(400).json({
            success: false,
            data: null,
            error: "INVALID_REQUEST",
        });
    }

    const title = "Hello this is an dummy title";

    const [project] = await db
        .insert(projects)
        .values({
            title,
            initialPrompt: data.prompt,
            userId: req.userId!,
        })
        .returning();
    const projectId = project!.id as string;

    await db
        .insert(conversationHistory)
        .values({
            projectId: project!.id,
            type: "TEXT_MESSAGE",
            from: "USER",
            contents: data.prompt,
            toolCall: null,
        })
        .returning();

    const jobId = createRandomJobId();
    await publishToStream(BackendToOrchestator, {
        type: CREATE_PROJECT,
        projectId,
        jobId,
        userId: req.userId!,
        prompt: data.prompt,
    });
    try {
        const result = await responseManager.wait(projectId, 120_000, [
            PROJECT_INITIALIZED,
            PROJECT_FAILED,
        ]);
        const parsed = JSON.parse(result);

        if (parsed.type === PROJECT_INITIALIZED) {
            return res.status(201).json({
                success: true,
                data: { projectId },
                error: null,
            });
        } else if (parsed.type === PROJECT_FAILED) {
            return res.status(500).json({
                success: false,
                data: null,
                error: parsed.payload ?? "PROJECT_CREATION_FAILED",
            });
        } else {
            return res.status(500).json({
                success: false,
                data: null,
                error: "UNEXPECTED_RESPONSE",
            });
        }
    } catch (err) {
        console.error(`Create project timeout for ${projectId}:`, err);
        return res.status(504).json({
            success: false,
            data: null,
            error: "TIMEOUT",
        });
    }
};

export const getProject = async (req: Request, res: Response) => {
    const userProjects = await db
        .select()
        .from(projects)
        .where(eq(projects.userId, req.userId!))
        .orderBy(desc(projects.createdAt));

    return res.status(200).json({
        success: true,
        data: userProjects,
        error: null,
    });
};

export const getProjectById = async (req: Request, res: Response) => {
    const projectId = String(req.params.projectId ?? "");

    const projectResult = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, req.userId!)))
        .limit(1);

    const project = projectResult[0];

    if (!project) {
        return res.status(404).json({
            success: false,
            data: null,
            error: "PROJECT_NOT_FOUND",
        });
    }

    const history = await db
        .select()
        .from(conversationHistory)
        .where(eq(conversationHistory!.projectId, projectId))
        .orderBy(asc(conversationHistory.createdAt));

    return res.status(200).json({
        success: true,
        data: {
            ...project,
            conversationHistory: history,
        },
        error: null,
    });
};

export const createConversation = async (req: Request, res: Response) => {
    const projectId = String(req.params.projectId ?? "");
    const { prompt } = req.body;

    if (!prompt) {
        return res.status(400).json({
            success: false,
            error: "PROMPT_REQUIRED",
        });
    }

    const project = await db
        .select()
        .from(projects)
        .where(
            and(eq(projects.id, projectId), eq(projects.userId, req.userId!)),
        )
        .limit(1);

    if (project.length === 0) {
        return res.status(404).json({
            success: false,
            error: "PROJECT_NOT_FOUND",
        });
    }

    const jobId = createRandomJobId();

    await publishToStream(BackendToOrchestator, {
        type: PROMPT,
        projectId,
        jobId,
        userId: req.userId,
        prompt,
    });

    try {
        const response = await responseManager.wait(projectId, 600_000, [
            PROMPT_RESPONSE,
            PROJECT_FAILED,
        ]);
        const parsed = JSON.parse(response);

        if (parsed.type === PROMPT_RESPONSE) {
            const token =
                typeof req.headers.authorization === "string"
                    ? req.headers.authorization.replace(/^Bearer\s+/i, "")
                    : "";
            const sseUrl = `/api/v1/project/${projectId}/events?token=${encodeURIComponent(token)}`;
            return res.status(200).json({
                success: true,
                data: {
                    sseUrl,
                },
                error: null,
            });
        } else if (parsed.type === PROJECT_FAILED) {
            return res.status(500).json({
                success: false,
                data: null,
                error: parsed.payload ?? "PROMPT_PROCESSING_FAILED",
            });
        } else {
            return res.status(500).json({
                success: false,
                error: "UNEXPECTED_RESPONSE",
            });
        }
    } catch (err) {
        console.error("Prompt timeout or error:", err);
        return res.status(504).json({
            success: false,
            error: "TIMEOUT",
        });
    }
};
