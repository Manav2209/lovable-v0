import { Router } from "express";
import { login, signup } from "../controller/auth";
import { authRateLimiter } from "../lib/rateLimit";

export const authRouter = Router();

authRouter.post('/signup' , authRateLimiter, signup)

authRouter.post("/login" , authRateLimiter, login)
