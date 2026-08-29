import jwt from "jsonwebtoken";
import type { NextFunction, Request, Response } from "express";

export function authMiddleware(req: Request, res: Response, next: NextFunction) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
        success: false,
        data: null,
        error: "UNAUTHORIZED",
        });
    }

    const token = authHeader.split(" ")[1]!;

    try {
        const decoded = jwt.verify(
            token,
            process.env.JWT_SECRET!,
        ) as jwt.JwtPayload & { id?: string };
        req.userId = decoded?.id;
        next();
    } catch {
        return res.status(401).json({
        success: false,
        data: null,
        error: "UNAUTHORIZED",
        });
    }
}