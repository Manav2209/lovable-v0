
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

export const createProjectSchema = z.object({
    prompt: z.string().min(10)
})

export const conversationSchema = z.object({

    type:z.enum(["TOOL_CALL", "TEXT_MESSAGE"]),
    from: z.enum(["USER" , "ASSISTANT"]), 
    contents:z.string(), 
    toolCall :z.enum(["READ_FILE" ,"WRITE_FILE" ,"DELETE_FILE" ,"UPDATE_FILE"])
})
