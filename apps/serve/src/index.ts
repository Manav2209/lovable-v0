import {RedisManager} from "shared-redis";
import { ControlToServing , OrchestatorToServing  ,ServingToControl, PROJECT_INITIALIZED, PROJECT_RUN} from "types"
import path from "path";
import fs from "fs"
import { checkIfProjectFilesExist, serveTheProject } from "./lib/helper";
import {createClient} from "redis"

export const redis = await createClient().connect();   // writer

const controlReader = redis.duplicate();
const orchReader = redis.duplicate();
export let projectRunning = false;

async function ListenControl(){

    console.log("Reading from Control")
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
            const msgFromControl = JSON.parse(raw);
            const projectId = msgFromControl.projectId ;
            const type = msgFromControl.type;


            switch(type){
                case PROJECT_INITIALIZED :
                    try{
                        console.log("Proj initlaized reached to serving pod")
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
                        console.log("Serving pod message sent")
                        

                    }catch(error){
                        const errorMessage =
                        error instanceof Error ? error.message : String(error);

                        await redis.xAdd(ServingToControl, "*", {
                            data:JSON.stringify({
                                type: PROJECT_INITIALIZED,
                                success: "false",
                                payload: errorMessage,
                                projectId: projectId!
                            })
                        });
                        }
                    break;
                
                case PROJECT_RUN:
                    if(projectId){
                        if(!checkIfProjectFilesExist(projectId)) return ;
                        await serveTheProject(projectId);
                        console.log(`Project ${projectId} is now running.`);
                        projectRunning = true;
                    }
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
            const msgFromOrch = JSON.parse(raw);
            const type = msgFromOrch.type;
            const projectId = msgFromOrch.projectId ;

            switch(type){
                case PROJECT_RUN:
                    if(projectId){
                        if(!checkIfProjectFilesExist(projectId)) return ;
                        await serveTheProject(projectId);
                        console.log(`Project ${projectId} is now running.`);
                        projectRunning = true;
                    }
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

async function main() {
    await Promise.all([
        
        controlReader.connect(),
        orchReader.connect()
    ]);
    console.log("Serving POD Started");
    await Promise.all([
        ListenControl(),
        ListenOrchestator()
    ]);
}

main()



