import 'dotenv/config'
import {RedisManager} from "shared-redis";
import { OrchestatorToControl, ControlToServing, ControlToOrchestator, ServingToControl, PROJECT_INITIALIZED, PROJECT_BUILD, PROMPT} from "types";
import { listObjects , getObject} from "r2"
import fs from "fs"
import path from 'path';
import type { MessageFromServing } from './types';

const bucketName = process.env.BUCKET_NAME  || "lovable";

const redis = RedisManager.getStandardClient();


/*  Map -- > {
    projectId , Promise { 
        success: string,
        payload: string
    }

}*/
const processing = new Map<string,
(value: { success: string; payload?: string }) => void>();

function waitForServingConfirmation(
    projectId: string,
    timeoutMs = 60_000,
    ) {
        return new Promise<{ success: string; payload?: string }>(
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
                const msgfromOrch = msg.message ;
                console.log("Message:",msgfromOrch)
                const type = msgfromOrch.type;
                const projectId = msg.message.projectId!

                switch(type){
                    case PROJECT_INITIALIZED: 
                        try{
                             // pull the template from the R2
                            const ok = await pullTemplatefromR2(projectId);
                            if(!ok) {
                                throw new Error("template pull")
                            }

                            // Pushing initalization to serving Pod
                            await redis.xAdd(ControlToServing,"*", {
                                projectId,
                                type: PROJECT_INITIALIZED,
                                }
                            )
                            // Waiting for Response from Serving Pod
                            const result =
                            await waitForServingConfirmation(projectId);
            
                            if (result.success !== "true") {
                                throw new Error(result.payload || "Serving failed");
                            }
                            console.log(`[${projectId}] initialization done`);

                            await redis.xAdd(ControlToOrchestator, "*", {
                                projectId,
                                type: PROJECT_INITIALIZED,
                                success: "true",
                            });

                        }catch(e){
                            console.error(`[${projectId}] initialization failed`,e);

                            await redis.xAdd(ControlToOrchestator, "*", {
                                projectId,
                                type: PROJECT_INITIALIZED,
                                success: "false",
                                payload: String(e),
                            });
                        } 
                        break;

                    case PROJECT_BUILD:

                        break;
                        
                    case PROMPT:
                        break;

                }
            }
        
    }
}

async function ListenServing() {
    console.log("[CONTROL] Reading from Serving stream");
    let lastId =  "0";

    while (true) {
        const res = await redis.xRead(
            [{ key: ServingToControl, id: lastId }],
            { BLOCK: 0 }
        );
    
        if (!res) continue;
    
        const messages = res[0]!.messages;
    
        for (const msg of messages) {
            lastId = msg.id;
        
            const streamMsg = msg.message as MessageFromServing;
            console.log(streamMsg)
            const type = streamMsg.type;
            const projectId = streamMsg.projectId;
        
            switch(type) {
                case PROJECT_INITIALIZED :
                    if (!projectId) continue;
                    const resolver = processing.get(projectId);
                    if (!resolver) continue;
                    resolver({
                        success: streamMsg.success,
                        payload: streamMsg.payload
                    });

                    processing.delete(projectId);
                break;
            }
        }
    }
}
    

async function main() { 
    ListenOrchestator();
    ListenServing()

}

main()

