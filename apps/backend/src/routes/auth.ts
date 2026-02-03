import { Router } from "express";
import { LoginSchema, SignUpSchema } from "../lib/schema";
import { db } from "database";
import { users } from "../../../../packages/database/schema";
import bcrypt from "bcrypt";
import { eq, and, desc, asc } from "drizzle-orm";
import  jwt  from "jsonwebtoken"


export const authRouter = Router();
authRouter.post('/signup' ,async  (req  , res) => {
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

    return res.status(201).json({
        success: true,
        data: user,
        error: null,
    });
})

authRouter.post("/login" , async (req , res) => {
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

    const token = jwt.sign({ id: user.id }, process.env.JWT_SECRET!);

    return res.status(200).json({
        success: true,
        data: {
        token,
        user,
        },
        error: null,
    });
})
