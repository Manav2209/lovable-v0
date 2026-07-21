import type { ResponseManager } from "./src/lib/responseManager";

declare global {
    namespace Express {
      interface Request {
        userId?: string;
      }
    }
  }