import {RedisManager} from "shared-redis";
import {OrchestatorToControl} from "types";


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

                const id = message.id;
                const fields = message.message;
                lastId = id;

                console.log("Received from OrchestatorToControl:");
                console.log({
                id,
                fields,
                });

                switch(fields.type){
                    case "PROJECT_INITIALIZED": 

                    // pull the template from the R2

                    // Pushing initalization to serving Pod

                    // Waiting for Response from Serving Pod
                    

                    break;
                }
            }
        }



        
    }

}

main()