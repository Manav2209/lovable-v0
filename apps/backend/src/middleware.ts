import jwt from "jsonwebtoken";

export function authMiddleware(req: any, res: any, next: any) {
    const authHeader = req.headers.authorization;

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
        return res.status(401).json({
        success: false,
        data: null,
        error: "UNAUTHORIZED",
        });
    }

    const token = authHeader.split(" ")[1];

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET!) as any;
        req.userId = decoded.id;
        next();
    } catch {
        return res.status(401).json({
        success: false,
        data: null,
        error: "UNAUTHORIZED",
        });
    }
}