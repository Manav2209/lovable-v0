import { db } from "database";
import { users } from "../../../../packages/database/schema";
import { LoginSchema, SignUpSchema } from "../lib/schema";
import bcrypt from "bcrypt";
import { eq } from "drizzle-orm";
import jwt from "jsonwebtoken";
import type { StringValue } from "ms";
import type {Request , Response} from "express"


const TOKEN_TTL = (process.env.JWT_EXPIRES_IN || "7d") as StringValue;

/** Never return the password hash to clients. */
function publicUser<T extends { password?: string }>(user: T): Omit<T, "password"> {
    const { password: _password, ...safe } = user;
    return safe;
}

export const signup = async  (req : Request, res: Response) => {
    const { success, data } = SignUpSchema.safeParse(req.body);

    if (!success) {
        return res.status(400).json({
        success: false,
        data: null,
        error: "INVALID_REQUEST",
        });
    }

    const existingUser = await db
        .select()
        .from(users)
        .where(eq(users.email, data.email))
        .limit(1);

    if (existingUser.length > 0) {
        return res.status(400).json({
        success: false,
        data: null,
        error: "EMAIL_ALREADY_EXISTS",
        });
    }

    const hashedPassword = await bcrypt.hash(data.password, 10);

    const [user] = await db
        .insert(users)
        .values({
        email: data.email,
        username: data.username,
        password: hashedPassword,
        })
        .returning();

    if (!user) {
        return res.status(500).json({
        success: false,
        data: null,
        error: "SIGNUP_FAILED",
        });
    }

    return res.status(201).json({
        success: true,
        data: publicUser(user),
        error: null,
    });
}

export const login = async (req: Request, res: Response) => {
    const { success, data } = LoginSchema.safeParse(req.body);

    if (!success) {
        return res.status(400).json({
        success: false,
        data: null,
        error: "INVALID_REQUEST",
        });
    }

    const result = await db
        .select()
        .from(users)
        .where(eq(users.email, data.email))
        .limit(1);

    const user = result[0];

    if (!user) {
        return res.status(401).json({
        success: false,
        data: null,
        error: "EMAIL_DOESNOT_EXISTS",
        });
    }

    const validPassword = await bcrypt.compare(data.password, user.password);

    if (!validPassword) {
        return res.status(401).json({
        success: false,
        data: null,
        error: "INVALID_CREDENTIALS",
        });
    }

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET!, {
        expiresIn: TOKEN_TTL,
    });

    return res.status(200).json({
        success: true,
        data: {
        token,
        user: publicUser(user),
        },
        error: null,
    });
}
