import 'dotenv/config'
import { 
    BackendToOrchestator ,
    OrchestatorToControl ,  
    ControlToOrchestrator, 
    CREATE_PROJECT,
    PROJECT_BUILD,
    PROJECT_RUN,
    PROMPT,
    OrchestatorToBackend,
    PROJECT_BUILD_FAILED,
    PROJECT_BUILD_SUCCESS,
    PROJECT_FAILED,
    PROJECT_RUN_SUCCESS,
    PROMPT_RESPONSE,
    PROJECT_INITIALIZED, 
    PROJECT_CREATED,
    PROJECT_RUN_FAILED,
    ServingToOrchestrator,
    OrchestatorToServing} from "types";

import { createProjectPod } from "./handler/project";

import type { BackendPayload, ChatMessage, ControlMessage, ServingMessage} from "./types";
import { toK8sName } from "./lib";
import {createClient } from "redis"

console.log("Orchestrator started with env:", {
    NODE_ENV: process.env.NODE_ENV,
    REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
    SKIP_K8S: process.env.SKIP_K8S || "true",
});

// Two readers – one for each blocking stream
const backendReader = createClient();
const controlReader = createClient();
const serverReader = createClient();


// One writer – for all xAdd calls
const writer = createClient();

// we will store the response from Control and Server Pod
// Project ->  resolver
const serverResponses = new Map<string , (v: ServingMessage) => void>();
const controlResponses = new Map<string , (v: ControlMessage ) => void>();

function waitForServer(projectId: string, timeoutMs = 60_000) {
    return new Promise<ServingMessage>((resolve, reject) => {
        const timer = setTimeout(() => {
            serverResponses.delete(projectId);
            reject(new Error(`Serving pod timeout for ${projectId}`));
        }, timeoutMs);
        serverResponses.set(projectId, (value) => {
            clearTimeout(timer);
            resolve(value);
        });
    });
}

function waitForControl(projectId: string , timeoutMs = 60_000) {
    return new Promise<ControlMessage>((resolve , reject) => {
        const timer = setTimeout(() => {
            controlResponses.delete(projectId);
            reject(new Error("Control pod timeout"));
        }, timeoutMs);

        controlResponses.set(projectId, (value) => {
            clearTimeout(timer);
            resolve(value);
        });

    });
}

async function ListenBackend() {

    console.log("Listening on stream:", BackendToOrchestator);
    let lastId = "$";
    while (true) {
        const response = await backendReader.xRead(
            [{
                key: BackendToOrchestator,
                id: lastId,
            }],
            {
                BLOCK: 0 
            });
    if (!response) continue;
    //@ts-ignore
    const messages = response[0]!.messages;
        for (const msg of messages) {
            lastId = msg.id;
            const  msgfromBackend  = msg.message as ChatMessage
            const type = msgfromBackend.type  as string;
            const payloadRaw = msg.message.payload as string;

            const payload = JSON.parse(payloadRaw) as BackendPayload;
            console.log(payload)
            const { projectId , jobId , prompt, userId} = payload;
            switch(type){
                case CREATE_PROJECT:
                    createProject(projectId).catch(console.error);
                    break;

                case PROJECT_BUILD:
                    buildProject(projectId).catch(console.error)
                    break;
                    
                case PROJECT_RUN :
                    runProject(projectId).catch(console.error)
                    break;

                case PROMPT:
                    if (!prompt) {
                        console.log(`[${projectId}] Prompt missing payload`);
                        break;
                    }
                    handlePrompt(projectId, prompt!).catch(console.error);
                    break;
            } 
        }
    }
}

async function ListenControlPod() {
    let lastId = "$";

    while(true){
        const res = await controlReader.xRead(
            [{ key: ControlToOrchestrator, id: lastId }],
            { BLOCK: 0 }
        );
        if (!res) continue;
        console.log(res);
        //@ts-ignore
        for (const msg of res[0]!.messages) {
            lastId = msg.id;

            const raw = msg.message?.data;
            if (!raw) continue;
            let data: any
            try {
                data = JSON.parse(raw);
                console.log(data);
            } catch (e) {
                console.error("Failed to parse control message:", raw);
                continue;
            }
            const { projectId, type } = data;
            if (!projectId) continue;
            console.log(`[${projectId}] Received ${type} from control`);

             // Only resolve pending promises for non‑initialisation types
            // (we no longer wait for PROJECT_INITIALIZED from control)
            if (type !== PROJECT_INITIALIZED) {
                const resolver = controlResponses.get(projectId);
                if (resolver) {
                    resolver(data);
                    controlResponses.delete(projectId);
                }
            }
            // If we ever needed to forward initialisation from control, we would do it here,
            // but now it's handled by serving → orchestrator.
        }
    }    
}


async function ListenServingPod(){
    let lastId = "$";

    while(true){
        try{
        const res = await serverReader.xRead(
            [{ key: ServingToOrchestrator, id: lastId }],
            { BLOCK: 0 }
        );
        if(!res) continue;
        console.log(res);

        //@ts-ignore
        for (const msg of res[0]!.messages) {
            lastId = msg.id;

            const raw = msg.message?.data;
            if (!raw) continue;
            let data: any;
            try {
                data = JSON.parse(raw);
            } catch (e) {
                console.error("Failed to parse serving message:", raw);
                continue;
            }
            const { projectId, type, success, payload } = data;
            if (!projectId) continue;
            console.log(`[${projectId}] Received ${type} from serving`);
        
            // 1. Resolve waiting promise (for RUN)
            const validRunTypes = [PROJECT_RUN_SUCCESS, PROJECT_RUN_FAILED, PROJECT_FAILED];
            if (validRunTypes.includes(type)) {
                const resolver = serverResponses.get(projectId);
                if (resolver) {
                    resolver(data);
                    serverResponses.delete(projectId);
                }
            }
            // 2. Forward relevant messages to backend
            switch (type) {
                case PROJECT_CREATED:
                    await writer.xAdd(OrchestatorToBackend, "*", {
                        data: JSON.stringify({ projectId, type: PROJECT_INITIALIZED })
                    });
                    console.log(`[${projectId}] Forwarded PROJECT_CREATED as PROJECT_INITIALIZED to backend`);
                    break;
                case PROJECT_FAILED:
                    await writer.xAdd(OrchestatorToBackend, "*", {
                        data: JSON.stringify({ projectId, type: PROJECT_FAILED, payload: payload || "" })
                    });
                    console.log(`[${projectId}] Forwarded PROJECT_FAILED to backend`);
                    break;
                default:
                    break;
                }
            }
        }catch(err){
            console.error("Error in ListenServingPod:", err);
            await new Promise(resolve => setTimeout(resolve, 1000));
        }
    }

}


async function createProject(projectId: string) {
    
    const skipK8s = process.env.SKIP_K8S?.toLowerCase() === "true";
    console.log(`[${projectId}] SKIP_K8S = ${skipK8s}`);

    if (!skipK8s) {
        try {
            await createProjectPod(toK8sName(projectId));
            console.log(`[${projectId}] K8s pod created`);
        } catch (err) {
            console.error(`[${projectId}] K8s pod creation failed:`, err);
            await writer.xAdd(OrchestatorToBackend, "*", {
                data: JSON.stringify({ projectId, type: PROJECT_FAILED, payload: String(err) })
            });
            return; // <-- stop here
        }
    } else {
        console.log(`[${projectId}] Skipping K8s pod creation (SKIP_K8S=true)`);
    }

    // Fire‑and‑forget to control
    await writer.xAdd(OrchestatorToControl, "*", {
        data: JSON.stringify({ type: PROJECT_INITIALIZED, projectId })
    });
    console.log(`[${projectId}] PROJECT_INITIALIZED sent to control, waiting for async response from serving`);
}
async function buildProject(projectId: string){
    console.log("BUILD_PROJECT is being called");
    
    await writer.xAdd(OrchestatorToControl, "*", {
        data: JSON.stringify({
            projectId,
            type: PROJECT_BUILD
        })
    });
    
    try {
        const response = await waitForControl(projectId);
        if (response.type === PROJECT_BUILD_SUCCESS) {
            await writer.xAdd(OrchestatorToBackend, "*", {
                data: JSON.stringify({ projectId, type: PROJECT_BUILD_SUCCESS })
            });
            console.log(`[${projectId}] Build success forwarded`);
        } else if (response.type === PROJECT_BUILD_FAILED) {
            await writer.xAdd(OrchestatorToBackend, "*", {
                data: JSON.stringify({ projectId, type: PROJECT_BUILD_FAILED, payload: response.payload || "" })
            });
            console.log(`[${projectId}] Build failed forwarded`);
        } else if (response.type === PROJECT_FAILED) {
            await writer.xAdd(OrchestatorToBackend, "*", {
                data: JSON.stringify({ projectId, type: PROJECT_FAILED, payload: response.payload || "" })
            });
        }
    } catch (err) {
        console.error(`[${projectId}] Build timeout or error:`, err);
        await writer.xAdd(OrchestatorToBackend, "*", {
            data: JSON.stringify({ projectId, type: PROJECT_BUILD_FAILED, payload: String(err) })
        });
    }


}

async function runProject(projectId : string) {
    console.log(`[${projectId}] RUN_PROJECT called`);

    await writer.xAdd(OrchestatorToServing, "*", {
        data: JSON.stringify({
            projectId,
            type: PROJECT_RUN
        })
    });

    try {
        const response = await waitForServer(projectId);
        if (response.type === PROJECT_RUN_SUCCESS) {
            await writer.xAdd(OrchestatorToBackend, "*", {
                data: JSON.stringify({ projectId, type: PROJECT_RUN_SUCCESS })
            });
            console.log(`[${projectId}] Run success forwarded`);
        } else if (response.type === PROJECT_RUN_FAILED) {
            await writer.xAdd(OrchestatorToBackend, "*", {
                data: JSON.stringify({ projectId, type: PROJECT_RUN_FAILED, payload: response.payload || "" })
            });
            console.log(`[${projectId}] Run failed forwarded`);
        } else if (response.type === PROJECT_FAILED) {
            await writer.xAdd(OrchestatorToBackend, "*", {
                data: JSON.stringify({ projectId, type: PROJECT_FAILED, payload: response.payload || "" })
            });
        }
    } catch (err) {
        console.error(`[${projectId}] Run timeout or error:`, err);
        await writer.xAdd(OrchestatorToBackend, "*", {
            data: JSON.stringify({ projectId, type: PROJECT_RUN_FAILED, payload: String(err) })
        });
    }

}

async function handlePrompt( projectId : string , prompt: string) {
    console.log(`[${projectId}] PROMPT called`);
    await writer.xAdd(OrchestatorToControl, "*", {
        data: JSON.stringify({ projectId, type: PROMPT, payload: prompt })
    });

    try {
        const response = await waitForControl(projectId);
        if (response.type === PROMPT_RESPONSE) {
            await writer.xAdd(OrchestatorToBackend, "*", {
                data: JSON.stringify({ projectId, type: PROMPT_RESPONSE, payload: response.payload || "" })
            });
            console.log(`[${projectId}] Prompt response forwarded`);
        } else {
            console.log(`[${projectId}] Unexpected prompt response: ${response.type}`);
        }
    } catch (err) {
        console.error(`[${projectId}] Prompt timeout or error:`, err);
        await writer.xAdd(OrchestatorToBackend, "*", {
            data: JSON.stringify({ projectId, type: PROMPT_RESPONSE, payload: "Error: " + String(err) })
        });
    }
    
}

async function shutdown(signal: string) {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    try {
        await writer.quit();
        await backendReader.quit();
        await controlReader.quit();
        await serverReader.quit();
        console.log("All Redis connections closed.");
    } catch (err) {
        console.error("Error during shutdown:", err);
    }
    process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() {

    await Promise.all([
        serverReader.connect(),
        backendReader.connect(),
        controlReader.connect(),
        writer.connect()
    ]);
    console.log("All Redis clients connected.");

    // Start all listeners concurrently
    await Promise.all([
        ListenBackend(),
        ListenControlPod(),
        ListenServingPod(),
    ]);
}

main().catch((error) => {
    console.error("Fatal error in Orchestrator:", error);
    process.exit(1);
});