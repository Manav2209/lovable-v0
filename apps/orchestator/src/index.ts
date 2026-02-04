import { RedisManager } from "shared-redis";
import { BackendToOrchestator, OrchestatorToControl } from "types";
import { createProjectPod } from "./handler/project";

const redis = RedisManager.getStandardClient();

const GROUP = "orchestrator-group";
const CONSUMER = `orch-${process.pid}`;

async function ensureGroup() {
  try {
    await redis.xGroupCreate(BackendToOrchestator, GROUP, "0", {
      MKSTREAM: true,
    });
  } catch (e: any) {
    if (!String(e?.message).includes("BUSYGROUP")) {
      throw e;
    }
  }
}

async function main() {
  await ensureGroup();

  console.log("Listening (group) on stream:", BackendToOrchestator);

  while (true) {
    const response = await redis.xReadGroup(
      GROUP,
      CONSUMER,
      [
        {
          key: BackendToOrchestator,
          id: ">",     // very important
        },
      ],
      {
        BLOCK: 5000,
        COUNT: 10,
      }
    );

    if (!response) continue;

    for (const stream of response) {
      for (const message of stream.messages) {
        const id = message.id;
        const fields = message.message as any;

        console.log("Received from BackendToOrchestator:", {
          id,
          fields,
        });

        try {
          switch (fields.type) {
            case "CREATE_PROJECT": {
              console.log("inside create Project");

              const projectId = "proj-" + fields.projectId;

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

          // acknowledge only after successful handling
          await redis.xAck(BackendToOrchestator, GROUP, id);

        } catch (err) {
          console.error("Error processing message", id, err);
          // do NOT ack → message stays pending
        }
      }
    }
  }
}

main().catch(console.error);
