import 'dotenv/config'
import {RedisManager} from "shared-redis";
import { OrchestatorToControl, ControlToServing} from "types";
import { listObjects , getObject} from "r2"
import fs from "fs"
import path from 'path';


const bucketName = process.env.BUCKET_NAME  || "lovable";


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
    try{
        // check if template exists
        const { Contents } = await listObjects({
            Bucket: bucketName,
            Prefix: "template/",
        });
    

        if (!Contents || Contents.length === 0) {
            throw new Error("No template files found in bucket");
        }
        // create a shared Dir
        const sharedDir = process.env.SHARED_DIR || "/app/shared";
        const projectDir = path.join(sharedDir, projectId);
    
        if (!fs.existsSync(sharedDir)) {
            fs.mkdirSync(sharedDir, { recursive: true });
        }
    
        fs.mkdirSync(projectDir, { recursive: true });
    
        for (const obj of Contents) {
            if (!obj.Key) continue;
        
            if (obj.Key === "template/") continue;
        
            const relativePath = obj.Key.replace("template/", "");
        
            try {
                const { Body } = await getObject({
                Bucket: bucketName,
                Key: obj.Key,
                });
        
                const filePath = path.join(projectDir, relativePath);
        
                const fileDir = path.dirname(filePath);
                if (!fs.existsSync(fileDir)) {
                fs.mkdirSync(fileDir, { recursive: true });
                }
        
                const buffer = Buffer.from(
                (await Body?.transformToByteArray()) || new Uint8Array(),
                );
                fs.writeFileSync(filePath, buffer);
                    } catch (error) {
                        console.error(`Failed to download ${obj.Key}:`, error);
                    }
                console.log("completed")
                return true;
                }
            }catch (error) {
                console.error("Error in  pull code from bucket:", error);
                const errorMessage = error instanceof Error ? error.message : String(error);
                console.log(errorMessage);
                return false;
        }

}

async function main() { 
    ListenOrchestator()

}

main()

