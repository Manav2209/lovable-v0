import { RedisManager } from "shared-redis";
import { BackendToOrchestator  , OrchestatorToControl , ServingToOrchestator , ControlToOrchestator } from "types";
import { createProjectPod } from "./handler/project";
import type { ChatMessage, ServingResponse } from "./types";

// we will store the response from Control and Server Pod

const serverResponses = new Map<string , (v: string) => void>();
const controlResponses = new Map<string , (v: string ) => void>();


function waitForServer(projectId: string) {
    return new Promise<string>((resolve) => {
        serverResponses.set(projectId, resolve);
    });
}

function waitForControl(projectId: string) {
    return new Promise<string>((resolve) => {
        controlResponses.set(projectId, resolve);
    });
}


// Redis initalization
const redis = RedisManager.getStandardClient();

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
            const payload = msgfromBackend.payload;

            const { projectId , jobId , userId} = payload;

            switch(type){
                case "CREATE_PROJECT":
                    createProject(projectId)
                    break;

                case "PROJECT_BUILD":
                    buildProject()
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

    }    
}
async function ListenServicePod() {
    let lastId = "$";

    while(true){
        const res = await redis.xRead(
            [{ key: ServingToOrchestator, id: lastId }],
            { BLOCK: 0 }
        );
        if (!res) continue;
        console.log(res);

        for( const msg of res[0]?.messages!){
            lastId = msg.id;

            const msgfromService = msg.message as ServingResponse;

            const type = msgfromService.type as string;
            const projectId = msgfromService.projectId;

            const resolver = serverResponses.get(projectId);
            if (resolver) {
                resolver(type);
                serverResponses.delete(projectId);
            }

            switch(type) {
                case "PROJECT_CREATED":
                    break;
            }
        }
    } 

}

async function createProject(projectId : string){
    await createProjectPod(projectId);
    await redis.xAdd(
        OrchestatorToControl,
        projectId,
        {
            type:"PROJECT_INITIALIZED",
        }
    );

}
async function buildProject(){
    console.log("BUILD_PROJECT is being called")
}

async function main() {
    ListenBackend()
    ListenControlPod();
    ListenServicePod()
}

main().catch(console.error);