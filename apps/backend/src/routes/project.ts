import { Router } from "express";
import { createRandomJobId, publishToStream } from "../lib/helper";
import {
    BackendToOrchestator,
    PROJECT_BUILD,
    PROJECT_BUILD_FAILED,
    PROJECT_BUILD_SUCCESS,
    PROJECT_FAILED,
    PROJECT_RUN,
    PROJECT_RUN_FAILED,
    PROJECT_RUN_SUCCESS,
} from "types";
import { authMiddleware } from "../middleware";
import { db } from "database";
import { eq, and } from "drizzle-orm";

import { projects } from "../../../../packages/database/schema";
import {
    createConversation,
    createProject,
    getProject,
    getProjectById,
} from "../controller/project";
import { projectEvents } from "../controller/events";
import { responseManager } from "../lib/responseManager";
import { mintSseTicket, SSE_TICKET_TTL_MS } from "../lib/sseTicket";
import { projectCreateRateLimiter } from "../lib/rateLimit";

export const projectRouter = Router();

projectRouter.post("/project", authMiddleware, projectCreateRateLimiter, createProject);

projectRouter.get("/projects", authMiddleware, getProject);

projectRouter.get("/project/:projectId", authMiddleware, getProjectById);

projectRouter.post("/project/:projectId/events/ticket",
    authMiddleware,
    async (req, res) => {
        const projectId = String(req.params.projectId ?? "");

        const project = await db
            .select()
            .from(projects)
            .where(
                and(
                    eq(projects.id, projectId),
                    eq(projects.userId, req.userId!),
                ),
            )
            .limit(1);

        if (project.length === 0) {
            return res.status(404).json({
                success: false,
                data: null,
                error: "PROJECT_NOT_FOUND",
            });
        }

        const ticket = mintSseTicket(projectId, req.userId!);
        return res.status(200).json({
            success: true,
            data: { ticket, expiresInMs: SSE_TICKET_TTL_MS },
            error: null,
        });
    },
);

projectRouter.get("/project/:projectId/events", projectEvents);

projectRouter.post(
    "/project/conversation/:projectId",
    authMiddleware,
    createConversation,
);

projectRouter.post("/project/:projectId/run", authMiddleware, async (req, res) => {
    const projectId = String(req.params.projectId ?? "");

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
            data: null,
            error: "PROJECT_NOT_FOUND",
        });
    }

    const jobId = createRandomJobId();

    try {
        await publishToStream(BackendToOrchestator, {
            type: PROJECT_RUN,
            projectId,
            jobId,
            userId: req.userId!,
        });

        const runRes = await responseManager.wait(jobId, 600_000, [
            PROJECT_RUN_SUCCESS,
            PROJECT_RUN_FAILED,
            PROJECT_FAILED,
        ]);
        const runResponse = JSON.parse(runRes);

        if (runResponse.type === PROJECT_RUN_SUCCESS) {
            return res.status(200).json({
                success: true,
                data: {
                    url:
                        typeof runResponse.payload === "string" &&
                        runResponse.payload.length > 0
                            ? runResponse.payload
                            : null,
                },
                error: null,
            });
        } else if (
            runResponse.type === PROJECT_RUN_FAILED ||
            runResponse.type === PROJECT_FAILED
        ) {
            return res.status(500).json({
                success: false,
                data: null,
                error: runResponse.payload ?? "RUN_FAILED",
            });
        } else {
            return res.status(500).json({
                success: false,
                data: null,
                error: "UNKNOWN_RUN_RESPONSE",
            });
        }
    } catch (err) {
        console.log(err);
        return res.status(504).json({
            success: false,
            data: null,
            error: "TIMEOUT",
        });
    }
});

projectRouter.post(
    "/project/:projectId/build",
    authMiddleware,
    async (req, res) => {
        const projectId = String(req.params.projectId ?? "");

        const project = await db
            .select()
            .from(projects)
            .where(
                and(
                    eq(projects.id, projectId),
                    eq(projects.userId, req.userId!),
                ),
            )
            .limit(1);

        if (project.length === 0) {
            return res.status(404).json({
                success: false,
                data: null,
                error: "PROJECT_NOT_FOUND",
            });
        }

        const jobId = createRandomJobId();

        await publishToStream(BackendToOrchestator, {
            type: PROJECT_BUILD,
            projectId,
            jobId,
            userId: req.userId!,
        });

        try {
            const buildRes = await responseManager.wait(jobId, 600_000, [
                PROJECT_BUILD_SUCCESS,
                PROJECT_BUILD_FAILED,
                PROJECT_FAILED,
            ]);
            const buildResponse = JSON.parse(buildRes);

            if (buildResponse.type === PROJECT_BUILD_SUCCESS) {
                return res.status(200).json({
                    success: true,
                    data: null,
                    error: null,
                });
            } else if (buildResponse.type === PROJECT_BUILD_FAILED) {
                return res.status(500).json({
                    success: false,
                    data: null,
                    error: buildResponse.payload ?? "BUILD_FAILED",
                });
            } else if (buildResponse.type === PROJECT_FAILED) {
                return res.status(500).json({
                    success: false,
                    data: null,
                    error: buildResponse.payload ?? "INTERNAL_BUILD_ERROR",
                });
            } else {
                return res.status(500).json({
                    success: false,
                    data: null,
                    error: "UNKNOWN_RESPONSE",
                });
            }
        } catch (err) {
            console.error(err);
            return res.status(504).json({
                success: false,
                data: null,
                error: "TIMEOUT",
            });
        }
    },
);
