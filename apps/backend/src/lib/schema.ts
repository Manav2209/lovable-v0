
import z from "zod";

export const normalizeEmail = (v: string) => v.trim().toLowerCase();

export const SignUpSchema = z.object({
    username : z.string().min(1).max(128),
    email: z.string().email().transform(normalizeEmail),
    password: z.string().min(6).max(72)
})

export const LoginSchema = z.object({
    email : z.string().email().transform(normalizeEmail),
    password: z.string().max(72)
})

export const createProjectSchema = z.object({
    prompt: z.string().min(10)
})

