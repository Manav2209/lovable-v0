import 'dotenv/config'
import {RedisManager} from "shared-redis";
import { OrchestatorToControl, ControlToServing} from "types";


const bucketName = process.env.BUCKET_NAME;


const redis = RedisManager.getStandardClient();

const inflight = new Set<string>();

const processing = new Map<
    string,
    (value: { success: boolean; payload?: string }) => void
>();

function waitForServingConfirmation(
    projectId: string,
    timeoutMs = 60_000,
    ) {
        return new Promise<{ success: boolean; payload?: string }>(
        (resolve, reject) => {
    
            const timer = setTimeout(() => {
            processing.delete(projectId);
            reject(new Error("Serving pod timeout"));
            }, timeoutMs);
    
            processing.set(projectId, (value) => {
            clearTimeout(timer);
            resolve(value);
            });
        },
        );
    }


async function ListenOrchestator(){
    console.log("Reading from Orchestator")
    let lastId = "0";
    while (true) {
        const res = await redis.xRead(
            [{ key: OrchestatorToControl, id: lastId }],
            { BLOCK: 0},
        );

    
        if (!res) continue;
    
        const messages = res[0]!.messages;

            for (const msg of messages) {
                
                lastId = msg.id;
                const msgfromOrch = msg.message;
                console.log("Message:",msgfromOrch)
                const type = msgfromOrch.type;
                const projectId = msg.message.projectId!

                switch(type){
                    case "PROJECT_INITIALIZED": 
                    if (inflight.has(projectId)) {
                        console.log("Already inflight:", projectId);
                        break;
                        }
                
                        inflight.add(projectId);
                        try{
                             // pull the template from the R2
                            await pullTemplatefromR2(projectId);

                    // Pushing initalization to serving Pod
                            await redis.xAdd(
                                ControlToServing,
                                "*",
                                {
                                projectId,
                                type: "PROJECT_INITIALIZED",
                                },
                            )
                    // Waiting for Response from Serving Pod
                        const result =
                        await waitForServingConfirmation(projectId);
        
                        if (!result.success) {
                            throw new Error(result.payload || "Serving failed");
                        }
                            console.log(
                                `[${projectId}] initialization done`,
                            );

                        }catch(e){
                            console.error(
                                `[${projectId}] initialization failed`,
                                e
                            );
                        } finally {
                            inflight.delete(projectId);
                        }


                    break;
                }
            }
        
    }
}

async function pullTemplatefromR2(projectId: string) {


}
async function main() { 
    ListenOrchestator()
}

main()