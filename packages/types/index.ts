
// Redis Stream 
export const BackendToOrchestator ="backend:orch";
export const OrchestatorToBackend = "orch:backend";

export const OrchestatorToControl = "orch:control";
export const ControlToOrchestrator = "control:orch";

export const ControlToServing="control:serving"
export const ServingToControl = "serving:control"

export const OrchestatorToServing="orch:serve";
export const ServingToOrchestrator= "serve:orch";

// Message key :

export const CREATE_PROJECT = "CREATE_PROJECT";
export const DELETE_PROJECT = "DELETE_PROJECT";

export const PROJECT_CREATED = "PROJECT_CREATED";
export const PROJECT_DELETED = "PROJECT_DELETED";
export const PROJECT_INITIALIZED = "PROJECT_INITIALIZED";



export const PROJECT_FAILED = "PROJECT_FAILED";

export const PROJECT_BUILD = "PROJECT_BUILD";
export const PROJECT_BUILD_SUCCESS = "PROJECT_BUILD_SUCCESS";
export const PROJECT_BUILD_FAILED = "PROJECT_BUILD_FAILED";

export const PROJECT_RUN = "PROJECT_RUN";
export const PROJECT_RUN_SUCCESS = "PROJECT_RUN_SUCCESS";
export const PROJECT_RUN_FAILED = "PROJECT_RUN_FAILED";

export const PROJECT_STOP = "PROJECT_STOP";

export const PROMPT = "PROMPT";
export const PROMPT_RESPONSE = "PROMPT_RESPONSE";

/** Redis pub/sub channel prefix for agent live events: `agent:sse:{projectId}` */
export const AgentSseChannelPrefix = "agent:sse:";

export function agentSseChannel(projectId: string): string {
    return `${AgentSseChannelPrefix}${projectId}`;
}

/**
 * Validates a project id supplied by any actor other than the backend
 * (stream messages, ingress routes, R2 keys). Rejects path separators,
 * `..` escapes, and control characters so the id can never walk out of
 * `SHARED_DIR/<projectId>` when joined onto a filesystem path.
 */
export function assertSafeProjectId(projectId: string): string {
    if (
        typeof projectId !== "string" ||
        projectId.length === 0 ||
        projectId.length > 128 ||
        !/^[A-Za-z0-9._-]+$/.test(projectId) ||
        projectId.includes("..") ||
        projectId.startsWith(".") ||
        projectId.endsWith(".")
    ) {
        throw new Error(`Invalid project id: ${String(projectId ?? "").slice(0, 64)}`);
    }
    return projectId;
}

export * from "./preview";

