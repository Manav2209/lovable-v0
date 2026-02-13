import {RedisManager} from "shared-redis";
import { ControlToServing , ServingToOrchestator , OrchestatorToServing  ,ServingToControl, PROJECT_BUILD, PROJECT_INITIALIZED, PROJECT_RUN} from "types"
import path from "path";
import fs from "fs"


export const redis = RedisManager.getStandardClient();

async function ListenControl(){

    console.log("Reading from Control")
    let lastId = "0";
    while (true) {
        const res = await redis.xRead(
            [{ key: ControlToServing, id: lastId }],
            { BLOCK: 0},
        );

    
        if (!res) continue;
    
        const messages = res[0]!.messages;

            for (const msg of messages) {
            lastId = msg.id;
            const msgFromControl = msg.message;
            console.log(msgFromControl)
            const projectId = msgFromControl.projectId ;
            const type = msgFromControl.type;


            switch(type){
                case PROJECT_INITIALIZED :
                    try{
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
                                type: PROJECT_INITIALIZED,
                                success: "true",
                                projectId : projectId!,
                            
                        });

                    }catch(error){
                        const errorMessage =
                        error instanceof Error ? error.message : String(error);

                        await redis.xAdd(ServingToControl, "*", {
                            type: PROJECT_INITIALIZED,
                            success: "false",
                            payload: errorMessage,
                            projectId: projectId!
                        });
                        }
                    break;
            }
    }
    
}

async function ListenOrchestator() {
    console.log("Reading from Orchestator Stream")
    let lastId = "0";

    while(true){
        const res = await redis.xRead(
            [{ key: OrchestatorToServing, id: lastId }],
            { BLOCK: 0 }
            );
        if (!res) continue;

        const messages = res[0]!.messages;
        
        for(const msg of messages){
            lastId = msg.id;
            const msgFromOrch = msg.message ;
            const type = msgFromOrch.type;
            const projectId = msgFromOrch.projectId ;

            switch(type){
                case PROJECT_RUN:
                    break;
            }
        }
    }
    }
}
async function main() {

    console.log("Serving Pod Started");

    ListenControl();
}

main()

