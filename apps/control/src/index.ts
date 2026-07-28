import 'dotenv/config'
import { 
    OrchestatorToControl,
    ControlToServing,
    ServingToControl,
    PROJECT_INITIALIZED,
    PROJECT_BUILD,
    PROMPT,
    ServingToOrchestrator,
    PROJECT_FAILED,
    PROJECT_BUILD_FAILED,
    PROJECT_BUILD_SUCCESS,
    ControlToOrchestrator} from "types";
import { listObjects , getObject} from "r2"
import fs from "fs"
import path from 'path';
import { buildProjectAndNotifyToRun } from './agent/tool/code/buildSource';
import { processPrompt } from './agent';
import { startSSEServer } from './sse';
import {createClient } from "redis"

const bucketName = process.env.BUCKET_NAME  || "lovable";

console.log("Control POD started with env:", {
    NODE_ENV: process.env.NODE_ENV,
    PROJECT_ID: process.env.PROJECT_ID,
    BUCKET_NAME: process.env.BUCKET_NAME,
    REDIS_URL: process.env.REDIS_URL || "redis://localhost:6379",
    SHARED_DIR: process.env.SHARED_DIR || "/app/shared",
    GROQ_API_KEY: process.env.GROQ_API_KEY ? "***" : undefined,
});

export const redis =  createClient({
    url: process.env.REDIS_URL || "redis://localhost:6379",
    socket: {
        family: 4,   // ✅ force IPv4
    }
});
// Use the same configuration as redis (optional)
const orchReader = redis.duplicate(); // new connection for Orchestator→Control
const servingReader = redis.duplicate(); // new connection for Serving→Control

/*  Map -- > {
    projectId , Promise { 
        success: string,
        payload: string
    }
}*/
const processing = new Map<string,(value: { success: string; payload?: string }) => void>();

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
        try {
            const { Contents } = await listObjects({
                Bucket: bucketName,
                Prefix: "template/",
            });
    
            if (!Contents || Contents.length === 0) {
                throw new Error("No template files found in bucket");
            }
    
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
                        (await Body?.transformToByteArray()) || new Uint8Array()
                    );
                    fs.writeFileSync(filePath, buffer);
                    console.log(`[${projectId}] Downloaded: ${relativePath}`);
                } catch (error) {
                    console.error(`Failed to download ${obj.Key}:`, error);
                }
            }
    
            console.log(`[${projectId}] Template pull completed (${Contents.length} files processed)`);
            return true;
        } catch (error) {
            console.error("Error in pullTemplatefromR2:", error);
            return false;
        }
    }

async function ListenOrchestator(){
    console.log("Reading from Orchestator")
    let lastId = "$";
    while (true) {
        const res = await orchReader.xRead(
            [{ key: OrchestatorToControl, id: lastId }],
            { BLOCK: 0},
        );
        if (!res) continue;
        //@ts-ignore
        const messages = res[0]!.messages;
            for (const msg of messages) {
                lastId = msg.id;
                const raw = msg.message?.data;
                if (!raw) {
                    console.log("Invalid message (missing data field)");
                    continue;
                }
                let parsed:any;
                try {
                    parsed = JSON.parse(raw);
                } catch (err) {
                    console.error("Failed parsing orchestrator msg:",raw);
                    continue;
                }
                console.log("Message:", parsed);
                const type = parsed.type;
                const projectId = parsed.projectId;
                if (!projectId) {
                    console.log("Missing projectId");
                    continue;
                }

                if (processing.has(projectId) && type === PROJECT_INITIALIZED) {
                    console.log(`Project ${projectId} is already being processed, skipping`);
                    continue;
                }

                
                switch(type){
                    case PROJECT_INITIALIZED: 
                        try{
                             // pull the template from the R2
                            const ok = await pullTemplatefromR2(projectId);
                            if(!ok) {
                                throw new Error("template pull failed")
                            }
                            console.log("temolate pull completed");

                            // Pushing initalization to serving Pod
                            await redis.xAdd(ControlToServing,"*", {
                                data: JSON.stringify({
                                    projectId,
                                    type:PROJECT_INITIALIZED
                                })
                                }
                            )
                            
                            // Waiting for Response from Serving Pod
                            const result = await waitForServingConfirmation(projectId);
            
                            if (result.success !== "true") {
                                throw new Error(result.payload || "Serving failed");
                            }
                            console.log(`[${projectId}] initialization done`);

                        }catch(e){
                            console.error(`[${projectId}] initialization failed`,e);
                            await redis.xAdd(ServingToOrchestrator, "*", {
                                data: JSON.stringify({
                                    type: PROJECT_FAILED,
                                    projectId,
                                    payload: String(e),
                                }),
                            });
                            // Also clean up the processing entry if it's still there
                        processing.delete(projectId);
                        } 
                        break;

                    case PROJECT_BUILD:
                        try {
                            const buildResultSuccess = await buildProjectAndNotifyToRun(projectId);
                            const responseType = buildResultSuccess
                                ? PROJECT_BUILD_SUCCESS
                                : PROJECT_BUILD_FAILED;
                    
                            await redis.xAdd(ControlToOrchestrator, "*", {
                                data: JSON.stringify({
                                    projectId,
                                    type: responseType,
                                    success: buildResultSuccess ? "true" : "false",
                                    payload: buildResultSuccess ? "" : "Build failed"
                                })
                            });
                            console.log(`[${projectId}] Build result (${responseType}) sent to orchestrator`);
                        } catch (error) {
                            console.error(`[${projectId}] Build error:`, error);
                            await redis.xAdd(ControlToOrchestrator, "*", {
                                data: JSON.stringify({
                                    projectId,
                                    type: PROJECT_BUILD_FAILED,
                                    success: "false",
                                    payload: String(error)
                                })
                            });
                        }
                        break;
                        
                    case PROMPT :
                        const prompt = parsed.payload;

                    if (!prompt) {
                        console.log("Prompt missing payload");
                        break;
                    }
                    try {
                        await processPrompt(projectId,prompt);
                    } catch (err) {
                        console.error("Prompt failed",err);
                    }
                        break;

                    default:
                        console.log("Unknown type:",type);
                        break;
                }
            }
        
    }
}

async function ListenServing() {
    console.log("[CONTROL] Reading from Serving stream");
    let lastId =  "$";

    while (true) {
        const res = await servingReader.xRead(
            [{ key: ServingToControl, id: lastId }],
            { BLOCK: 0 }
        );
    
        if (!res) continue;
        // @ts-ignore
        const messages = res[0]!.messages;
    
        for (const msg of messages) {
            lastId = msg.id;
        
            const raw = msg.message?.data;
            if (!raw) continue;
            let streamMsg: any;
            try {
                streamMsg = JSON.parse(raw);
            } catch (err) {
                console.error("Failed to parse serving message:", raw);
                continue;
            }

            const { type, projectId, success, payload } = streamMsg;
            if (!projectId) continue;

            // Resolve the waiting promise for this project (if any)
            const resolver = processing.get(projectId);
            if (resolver && type === PROJECT_INITIALIZED) {
                resolver({ success, payload });
                processing.delete(projectId);
            } else {
                console.log(
                    `Received unknown message: ${type} for project ${projectId} from SERVING_TO_CONTROL`
                );
            }
        }
    }
}

async function shutdown(signal: string) {
    console.log(`Received ${signal}. Shutting down gracefully...`);
    try {
        await redis.quit();
        await orchReader.quit();
        await servingReader.quit();
        console.log("All Redis connections closed.");
    } catch (err) {
        console.error("Error during shutdown:", err);
    }
    process.exit(0);
}

process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

async function main() { 
    await Promise.all([
        redis.connect(),
        orchReader.connect(),
        servingReader.connect()
    ]);
    console.log("redis connected")
    console.log("Control Pod is Running");
    startSSEServer();
     // Start listeners concurrently
    await Promise.all([
        ListenOrchestator(),
        ListenServing(),
    ]);
}

main().catch((error) => {
    console.error("Fatal error in Control POD:", error);
    process.exit(1);
});
