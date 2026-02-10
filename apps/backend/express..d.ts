import type { ResponseManager } from "./src/lib/responseManager";

declare global {
    namespace Express {
      interface Request {
        responseManager?: ResponseManager;
        userId?: string;
      }
    }
  }