import { Router } from "express";
import { createRandomJobId, createTitle, redis } from "../lib/helper";
import { BackendToOrchestator, PROJECT_BUILD, PROJECT_BUILD_FAILED, PROJECT_RUN, PROJECT_RUN_SUCCESS } from "types";
import { authMiddleware } from "../middleware";
import { conversationSchema, createProjectSchema } from "../lib/schema";
import { db } from "database";
import { eq, and, desc, asc } from "drizzle-orm";

import { conversationHistory, projects } from "../../../../packages/database/schema";
import { createConversation, createProject, getProject, getProjectById } from "../controller/project";



export const projectRouter = Router();

projectRouter.post("/project", authMiddleware, createProject)


projectRouter.get("/projects" , authMiddleware, getProject)

projectRouter.get("/project/:projectId" ,authMiddleware, getProjectById)

projectRouter.post("/project/conversation/:projectId", authMiddleware, createConversation);


projectRouter.post("/project/:projectId/run", authMiddleware, async (req, res) => {
    const { projectId } = req.params;

    const project = await db
        .select()
        .from(projects)
        .where(
            and(
            eq(projects.id, projectId),
            eq(projects.userId, req.userId!)
            )
        )
        .limit(1);

    if (project.length === 0) {
        return res.status(404).json({
            success: false,
            data: null,
            error: "PROJECT_NOT_FOUND"
        });
    }

    const jobId = createRandomJobId();

    // Trigger BUILD
    await redis.xAdd(BackendToOrchestator, "*", {
        type: PROJECT_BUILD,
        payload: JSON.stringify({
            projectId,
            jobId,
            userId: req.userId!
        })
    });

    try {
        const buildResponse =
            await req.responseManager!.wait(projectId, 30_000);

        if (buildResponse.type === PROJECT_BUILD_FAILED) {
            return res.status(500).json({
            success: false,
            data: null,
            error: buildResponse.error ?? "BUILD_FAILED"
            });
        }

        // Trigger RUN
        await redis.xAdd(BackendToOrchestator, "*", {
            type: PROJECT_RUN,
            payload: JSON.stringify({
                projectId,
                jobId,
                userId: req.userId!
            })
        });

        const runResponse =
            await req.responseManager!.wait(projectId, 30_000);

        if (runResponse.type === PROJECT_RUN_SUCCESS) {
            return res.status(200).json({
            success: true,
            data: {
                url: `${projectId}.localhost:3000`
            },
            error: null
            });
        }

        return res.status(500).json({
            success: false,
            data: null,
            error: runResponse.error ?? "RUN_FAILED"
        });

    } catch {
        return res.status(504).json({
            success: false,
            data: null,
            error: "TIMEOUT"
        });
    }
    }
);

projectRouter.post( "/project/:projectId/build", authMiddleware,async (req, res) => {
    const { projectId } = req.params;

    const project = await db
        .select()
        .from(projects)
        .where(
        and(
            eq(projects.id, projectId),
            eq(projects.userId, req.userId!)
        )
        )
        .limit(1);

    if (project.length === 0) {
        return res.status(404).json({
            success: false,
            data: null,
            error: "PROJECT_NOT_FOUND"
        });
    }

    const jobId = createRandomJobId();

    await redis.xAdd(BackendToOrchestator, "*", {
        type: PROJECT_BUILD,
        payload: JSON.stringify({
            projectId,
            jobId,
            userId: req.userId!
        })
    });

    try {
        const buildResponse =
            await req.responseManager!.wait(projectId, 30_000);

        if (buildResponse.type === "PROJECT_BUILD_SUCCESS") {
            return res.status(200).json({
                success: true,
                data: null,
                error: null
            });
        }

        return res.status(500).json({
            success: false,
            data: null,
            error: buildResponse.error ?? "BUILD_FAILED"
        });

    } catch {
        return res.status(504).json({
            success: false,
            data: null,
            error: "TIMEOUT"
        });
    }
    }
);