import { RedisManager } from "shared-redis";
import { BackendToOrchestator  , OrchestatorToControl} from "types";
import { createProjectPod } from "./handler/project";

const redis = RedisManager.getStandardClient();

async function main() {
    console.log("Listening on stream:", BackendToOrchestator);

    let lastId = "$";

    while (true) {
        const response = await redis.xRead(
        [
            {
            key: BackendToOrchestator,
            id: lastId,
            },
        ],
        {
            BLOCK: 5000, // wait 5s
            COUNT: 10,
        }
        );

    if (!response) continue;

    for (const stream of response) {
        for (const message of stream.messages) {
        const id = message.id;
        const fields = message.message;

        lastId = id;

        console.log("Received from BackendToOrchestator:");
            console.log({
            id,
            fields,
            });
        
        switch(fields.type){
            case "CREATE_PROJECT":
                console.log("inside create Project");
                const projectId = "proj-"+fields.projectId;
                if (!projectId) {
                console.log("Missing projectId");
                break;
                }
                console.log("Creating project pod:", projectId);
                await createProjectPod(projectId);
                await redis.xAdd(OrchestatorToControl, "*", {
                projectId,
                type: "PROJECT_INITIALIZED",
                });
                console.log("Sent PROJECT_INITIALIZED for", projectId);
            break;
        }
        
        }
        }
    }
}

main().catch(console.error);
