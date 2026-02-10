import {RedisManager} from "shared-redis";
import { ControlToServing , ServingToOrchestator , OrchestatorToServing  ,ServingToControl} from "types"


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
                case "PROJECT_INITIALIZED" :
                    try{
                        //send to Control -- > INITALIZATION_CONFIRMED ;
                        await redis.xAdd(ServingToControl, "*", {
                            key: projectId!,
                            value: JSON.stringify({
                                type: "PROJECT_INITALIZATION_CONFIRMED",
                                success: true,
                                payload: JSON.stringify({ projectId }),
                            }),
                        });

                        //send to Orchestator -- > PROJECT_CREATED;
                        await redis.xAdd(ServingToOrchestator , "*" , {
                            key:projectId!, 
                            value:JSON.stringify({
                                type:"PROJECT_CREATED",
                                projectId: projectId
                            })
                        })

                    }catch(error){
                        const errorMessage =
                            error instanceof Error ? error.message : String(error);

                        await redis.xAdd(ServingToControl, "*", {
                            key: projectId!,
                            value: JSON.stringify({
                                key: "PROJECT_INITALIZATION_CONFIRMED",
                                success: false,
                                payload: JSON.stringify({ error: errorMessage }),
                            }),
                            });

                            await redis.xAdd(ServingToOrchestator, "*", {
                            key: projectId!,
                            value: "PROJECT_FAILED",
                            });
                        }
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
            const msgFromOrch = msg.message;
        }
    }
}
async function main() {

    console.log("Serving Pod Started");

    ListenControl();
}

main()