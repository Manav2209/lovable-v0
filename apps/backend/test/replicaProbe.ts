import { mintSseTicket, redeemSseTicket } from "../src/lib/sseTicket";
import { ResponseManager } from "../src/lib/responseManager";
import { RedisManager } from "shared-redis";

const [action, first = "", second = ""] = process.argv.slice(2);
try {
  if (action === "mint") console.log(JSON.stringify({ ticket: await mintSseTicket(first, second) }));
  else if (action === "redeem") console.log(JSON.stringify(await redeemSseTicket(first)));
  else if (action === "resolve") {
    await new ResponseManager().resolve(first, JSON.stringify({ type: second, payload: "from another process" }));
    console.log("{}");
  } else throw new Error("Unknown replica probe action");
} finally { await RedisManager.quitAll(); }
