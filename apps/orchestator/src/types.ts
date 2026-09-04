

export type ChatMessage = {
    type: string;
    payload: string
};

export type BackendPayload = {
    projectId: string;
    jobId: string;
    userId: string;
    prompt?: string;
};

export type ControlMessage = {
    success: string
    projectId: string;
    type: string;
    payload?: string;
    jobId?: string;
};

export type ServingMessage = {
    projectId: string;
    type: string;
    payload?: string;
    jobId?: string;
};
