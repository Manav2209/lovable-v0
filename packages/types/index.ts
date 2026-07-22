
// Redis Stream 
export const BackendToOrchestator ="backend:orch";
export const OrchestatorToBackend = "orch:backend";

export const OrchestatorToControl = "orch:control";
export const ControlToOrchestator = "control:orch";

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



