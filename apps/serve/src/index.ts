
import { 
    ControlToServing , 
    OrchestatorToServing,
    ServingToControl,
    PROJECT_INITIALIZED,
    PROJECT_RUN,
    ServingToOrchestrator,
    PROJECT_CREATED,
    PROJECT_FAILED
} from "types"
import path from "path";
import fs from "fs"
import { checkIfProjectFilesExist, serveTheProject } from "./lib/helper";
import {createClient} from "redis";

console.log("Serving POD started with env:", {
    NODE_ENV: process.env.NODE_ENV,
    PROJECT_ID: process.env.PROJECT_ID,
    BUCKET_NAME: process.env.BUCKET_NAME,
    REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
    SHARED_DIR: process.env.SHARED_DIR ||  path.join(process.cwd(), 'shared') ,
});

export const redis = await createClient();   // writer

const controlReader = redis.duplicate();
const orchReader = redis.duplicate();
export let projectRunning = false;


async function ListenControl(){

    console.log("Reading from Control Stream" , ControlToServing)
    let lastId = "$";
    while (true) {
        const res = await controlReader.xRead(
            [{ key: ControlToServing, id: lastId }],
            { BLOCK: 0},
        );

        if (!res) continue;
        // @ts-ignore
        const messages = res[0]!.messages;

            for (const msg of messages) {
            lastId = msg.id;
            const raw = msg.message?.data;
            if (!raw) continue;
            let msgFromControl ;
            try {
                msgFromControl = JSON.parse(raw);
            } catch (err) {
                console.error("Failed to parse control message:", raw);
                continue;
            }
            const projectId = msgFromControl.projectId ;
            const type = msgFromControl.type;

            if (!projectId) {
                console.warn("Control message missing projectId");
                continue;
            }

            console.log(`[${projectId}] Received from control: ${type}`);


            switch(type){
                case PROJECT_INITIALIZED :
                    try{
                        console.log(`[${projectId}] Initialization started`);
                        const sharedDir = process.env.SHARED_DIR || "/app/shared";
                        const projectDir = path.join(sharedDir , projectId!)

                        // server checking 
                        if (!fs.existsSync(projectDir)) {
                            throw new Error("project workspace not found");
                        }

                        const files = fs.readdirSync(projectDir);
                        if (files.length === 0) {
                        throw new Error("project workspace is empty");
                        }
                        //send to Control Ack ;
                        await redis.xAdd(ServingToControl, "*", {
                            data: JSON.stringify({
                                type: PROJECT_INITIALIZED,
                                success: "true",
                                projectId
                            })
                            
                        });
                        
                        await redis.xAdd(ServingToOrchestrator, "*", {
                            data: JSON.stringify({
                                type: PROJECT_CREATED,
                                projectId,
                                success: "true",
                            })
                        });
                        console.log(`[${projectId}] PROJECT_CREATED sent to Orchestrator`);
                    }catch(error){
                        const errorMessage =
                        error instanceof Error ? error.message : String(error);

                        // Sent failure to Control
                        await redis.xAdd(ServingToControl, "*", {
                            data:JSON.stringify({
                                type: PROJECT_INITIALIZED,
                                success: "false",
                                payload: errorMessage,
                                projectId: projectId!
                            })
                        });

                        // Send failure to Orchestrator
                        await redis.xAdd(ServingToOrchestrator, "*", {
                            data: JSON.stringify({
                                type: PROJECT_FAILED,
                                projectId,
                                payload: errorMessage,
                            })
                        });

                        }
                    break;
                
                case PROJECT_RUN:
                    
                        console.log(`[${projectId}] PROJECT_RUN received from Control`);
                        if (!checkIfProjectFilesExist(projectId)) {
                            console.warn(`[${projectId}] Project files missing, skipping run`);
                            break;
                        }

                        await serveTheProject(projectId);
                        console.log(`Project ${projectId} is now running.`);
                        projectRunning = true;
                        break;
                    
                    
                default:
                        console.log(
                            `Received unknown message: ${type}} for project: ${projectId} from control pod`,
                        );
                        break;
            }
    }
    
}
}

async function ListenOrchestator () {
    console.log("Reading from Orchestator Stream")
    let lastId = "$";

    while(true){
        const res = await orchReader.xRead(
            [{ key: OrchestatorToServing, id: lastId }],
            { BLOCK: 0 }
            );
        if (!res) continue;

        //@ts-ignore
        const messages = res[0]!.messages;
        
        for(const msg of messages){
            lastId = msg.id;
            const raw = msg.message?.data;
            if (!raw) continue;

            let msgFromOrch ;

            try {
                msgFromOrch = JSON.parse(raw);
            } catch (err) {
                console.error("Failed to parse orchestrator message:", raw);
                continue;
            }

            const { projectId, type } = msgFromOrch;

            if (!projectId) {
                console.warn("Orchestrator message missing projectId");
                continue;
            }

            console.log(`[${projectId}] Received from orchestrator: ${type}`);

            switch(type){
                case PROJECT_RUN:
                    console.log(`[${projectId}] PROJECT_RUN received from Orchestrator`);
                    if (!checkIfProjectFilesExist(projectId)) {
                        console.warn(`[${projectId}] Project files missing, skipping run`);
                        break;
                    }                        
                    await serveTheProject(projectId);
                    console.log(`Project ${projectId} is now running.`);
                    projectRunning = true;
                    break;
                default:
                    console.log(
                        `Received unknown message: ${type}} for project: ${projectId} from control pod`,
                    );
                    break;
            }
        }
    }
}

async function shutdown(signal: string) {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    try {
        await redis.quit();
        await controlReader.quit();
        await orchReader.quit();
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
        redis.connect(),
        controlReader.connect(),
        orchReader.connect()
    ]);

    console.log("All Redis clients connected.");

    console.log("Serving POD Started");
    await Promise.all([
        ListenControl(),
        ListenOrchestator()
    ]);
}

main().catch((error) => {
    console.error("Fatal error in Serving POD:", error);
    process.exit(1);
});



