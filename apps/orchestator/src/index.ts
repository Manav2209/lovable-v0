import { RedisManager } from "shared-redis";

import { BackendToOrchestator , OrchestatorToControl , ServingToOrchestator , ControlToOrchestator, CREATE_PROJECT, PROJECT_BUILD, PROJECT_RUN, PROMPT, OrchestatorToBackend, PROJECT_BUILD_FAILED, PROJECT_BUILD_SUCCESS, PROJECT_FAILED, OrchestatorToServing, PROJECT_RUN_FAILED, PROJECT_RUN_SUCCESS, PROMPT_RESPONSE, PROJECT_INITIALIZED } from "types";

import { createProjectPod } from "./handler/project";

import type { BackendPayload, ChatMessage, ControlMessage, ServingMessage} from "./types";
import { toK8sName } from "./lib";

// Redis initalization
const redis = RedisManager.getStandardClient();

// we will store the response from Control and Server Pod
// Project ->  resolver
const serverResponses = new Map<string , (v: ServingMessage) => void>();
const controlResponses = new Map<string , (v: ControlMessage ) => void>();

function waitForServer(projectId: string) {
    return new Promise<ServingMessage>((resolve) => 
        {
            serverResponses.set(projectId, resolve); 
        })
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
        const response = await redis.xRead(
            [{
                key: BackendToOrchestator,
                id: lastId,
            }],
            {
                BLOCK: 0 
            });

    if (!response) continue;
    
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
                    createProject(projectId)
                    break;

                case PROJECT_BUILD:
                    buildProject(projectId)
                    break;
                    
                case PROJECT_RUN :
                    runProject(projectId)
                    break;

                case PROMPT:
                    handlePrompt(projectId, prompt!).catch(console.error);
                    break;
            } 
        }
    }
}

async function ListenControlPod() {
    let lastId = "$";

    while(true){
        const res = await redis.xRead(
            [{ key: ControlToOrchestator, id: lastId }],
            { BLOCK: 0 }
        );
        if (!res) continue;
        console.log(res);

        for (const msg of res[0]!.messages) {
            lastId = msg.id;

            const data = msg.message as ControlMessage;

            const resolver = controlResponses.get(data.projectId);
            if (resolver) {
                resolver(data);
                controlResponses.delete(data.projectId);
            }
        }
    }    
}


async function createProject(projectId : string){
    
    const k8sName = toK8sName(projectId);

    await createProjectPod(k8sName);

    console.log("Pod created")
    const message = await redis.xAdd(OrchestatorToControl,"*",{
        type:PROJECT_INITIALIZED,
        projectId: projectId
        }

    );
    console.log("Message send" , message)
    const response = await waitForControl(projectId);

    if (response.type === PROJECT_INITIALIZED && response.success === "true") {

        await redis.xAdd(OrchestatorToBackend, "*", {
            projectId,
            type: PROJECT_INITIALIZED
        });
        return;
    }

    await redis.xAdd(OrchestatorToBackend, "*", {
        projectId,
        type: PROJECT_FAILED,
        payload: response.payload ?? "initialization failed"
    });
}


async function buildProject(projectId: string){
    console.log("BUILD_PROJECT is being called");
    
    await redis.xAdd(OrchestatorToControl, "*", {
        projectId,
        type: PROJECT_BUILD
    });
    //TODO:  fix this type
    const response : any = await waitForControl(projectId);
    
    if (response.type === PROJECT_BUILD_SUCCESS) {
        await redis.xAdd(OrchestatorToBackend, "*", {
            projectId,
            type: PROJECT_BUILD_SUCCESS
        });
        return;
    }

    if (response.type === PROJECT_BUILD_FAILED) {
        await redis.xAdd(OrchestatorToBackend, "*", {
            projectId,
            type: PROJECT_BUILD_FAILED,
            payload: response.payload ?? ""
        });
        return;
    }
    
    if (response.type === PROJECT_FAILED) {
        await redis.xAdd(OrchestatorToBackend, "*", {
            projectId,
            type: PROJECT_FAILED,
            payload: response.payload ?? ""
        });
    }

}

async function runProject(projectId : string) {
    await redis.xAdd(OrchestatorToServing, "*", {
        projectId,
        type: PROJECT_RUN
    });
    
    const response : any = await waitForServer(projectId);
    
    if (response.type === PROJECT_RUN_SUCCESS) {
        await redis.xAdd(OrchestatorToBackend, "*", {
            projectId,
            type: PROJECT_RUN_SUCCESS
        });
        return;
    }
    
    if (response.type === PROJECT_RUN_FAILED) {
        await redis.xAdd(OrchestatorToBackend, "*", {
            projectId,
            type: PROJECT_RUN_FAILED,
            payload: response.payload ?? ""
        });
        return;
    }
    
    if (response.type === PROJECT_FAILED) {
        await redis.xAdd(OrchestatorToBackend, "*", {
            projectId,
            type: PROJECT_FAILED,
            payload: response.payload ?? ""
        });
    }

}

async function handlePrompt( projectId : string , prompt: string) {
    await redis.xAdd(OrchestatorToControl, "*", {
        projectId,
        type: PROMPT,
        payload: prompt
    });
    // fix the type
    const response : any = await waitForControl(projectId);
    
      // control pod returns SSE url
    if (response.type === PROMPT_RESPONSE) {
        await redis.xAdd(OrchestatorToBackend, "*", {
            projectId,
            type: PROMPT_RESPONSE,
            payload: response.payload ?? ""
        });
    }
    
}

async function main() {
    ListenBackend()
    ListenControlPod();
}

main().catch(console.error);