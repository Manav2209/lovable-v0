import { Router } from "express";
import { createRandomJobId, createTitle, redis } from "../lib/helper";
import { BackendToOrchestator } from "types";
import { authMiddleware } from "../middleware";
import { conversationSchema, createProjectSchema } from "../lib/schema";
import { db } from "database";
import { eq, and, desc, asc } from "drizzle-orm";

import { conversationHistory, projects } from "../../../../packages/database/schema";



export const projectRouter = Router();

projectRouter.post("/project", authMiddleware, async (req, res) => {
    const { success, data } = createProjectSchema.safeParse(req.body);

    if (!success) {
        return res.status(400).json({
            success: false,
            data: null,
            error: "INVALID_REQUEST"
        });
    }

    // const title = await createTitle(data.prompt);
    const title = "Hello this is an dummy title"

    const [project] = await db
        .insert(projects)
        .values({
            title,
            initialPrompt: data.prompt,
            userId: req.userId!,
        })
        .returning();
  
    const [message] = await db
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
        await redis.xAdd(BackendToOrchestator , "*" , {
            projectId : project!.id,
            jobId: jobId,
            type: "CREATE_PROJECT",
            userId : req.userId!
        });

    return res.status(201).json({
        success: true,
        data: {
            project,
            messageId: message!.id,
            jobId
        },
        error: null,
        });
    })

projectRouter.get("/projects" , authMiddleware,async (req, res) => {
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
})

projectRouter.get("/project/:projectId" ,authMiddleware, async (req, res) => {
    const { projectId } = req.params;

    const projectResult = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, req.userId!)))
        .limit(1);

    if (projectResult.length === 0) {
        return res.status(404).json({
            success: false,
            data: null,
            error: "PROJECT_NOT_FOUND",
        });
    }

    const history = await db
        .select()
        .from(conversationHistory)
        .where(eq(conversationHistory.projectId, projectId))
        .orderBy(asc(conversationHistory.createdAt));

    return res.status(200).json({
        success: true,
        data: {
            ...projectResult[0],
            conversationHistory: history,
        },
        error: null,
    });
})

projectRouter.post("/project/conversation/:projectId", authMiddleware, async (req, res) => {
    const { projectId } = req.params;
    const { success, data } = conversationSchema.safeParse(req.body);

    if (!success) {
        return res.status(400).json({
            success: false,
            data: null,
            error: "INVALID_REQUEST",
        });
    }

    const project = await db
        .select()
        .from(projects)
        .where(and(eq(projects.id, projectId), eq(projects.userId, req.userId!)))
        .limit(1);

    if (project.length === 0) {
        return res.status(404).json({
            success: false,
            data: null,
            error: "PROJECT_NOT_FOUND",
        });
    }

    const [message] = await db
        .insert(conversationHistory)
        .values({
            projectId,
            type: data.type,
            from: data.from,
            contents: data.contents,
            toolCall: data.toolCall ?? null,
        })
        .returning();

    return res.status(201).json({
        success: true,
        data: message,
        error: null,
    });
}
);