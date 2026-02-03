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
        console.log(response)
        
    }

}

main()