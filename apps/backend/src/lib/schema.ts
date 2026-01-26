
import z from "zod";

export const SignUpSchema = z.object({
    username : z.string().min(1),
    email:z.string().email().min(1),
    password: z.string().min(6)
})

export const LoginSchema = z.object({
    email :z.string().email(),
    password: z.string()
})
