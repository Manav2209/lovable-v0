import {RedisManager} from "shared-redis";
import {OrchestatorToControl} from "types";


pullTemplatefromR2(projectId) {

}
async function main() { 
    
    const redis = RedisManager.getStandardClient();
    let lastId = "$"
    while(true) {
        

        const response = await redis.xRead(
            [
                {
                key: OrchestatorToControl,
                id: lastId,
                },
            ],
            {
                BLOCK: 5000, // wait 5s
                COUNT: 10,
            }
            );
        console.log("Reading from Orchestator")
        
        if (!response) continue;

        for ( const stream of response){
            for (const message of stream.messages) {

                lastId = message.id;

                const fields = message.message as any;

                const projectId = fields.projectId;
                const type = fields.type;

                if (!projectId || !type) continue;

                console.log("CONTROL <- ORCH", projectId, type);

                switch(fields.type){
                    case "PROJECT_INITIALIZED": 

                    // pull the template from the R2
                    await pullTemplatefromR2(projectId)

                    // Pushing initalization to serving Pod
                    await pushProjectInitializationToServingPod(
                        projectId,
                        redis,
                      );

                    // Waiting for Response from Serving Pod
                    await waitForProjectInitializationConfirmation(projectId);

                    

                    break;
                }
            }
        }



        
    }

}

main()