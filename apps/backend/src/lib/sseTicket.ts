import { createHash, randomBytes } from "node:crypto";
import { RedisManager } from "shared-redis";

export const SSE_TICKET_TTL_MS = Number(process.env.SSE_TICKET_TTL_MS || 60000);

function ticketKey(token: string) {
  return `lovable:sse-ticket:${createHash("sha256").update(token).digest("hex")}`;
}

/** Opaque, short-lived tickets can be reused for EventSource reconnects on any replica. */
export async function mintSseTicket(projectId: string, userId: string): Promise<string> {
  const token = randomBytes(24).toString("base64url");
  const redis = await RedisManager.getWriter();
  await redis.set(ticketKey(token), JSON.stringify({ projectId, userId }), { PX: SSE_TICKET_TTL_MS });
  return token;
}

export async function redeemSseTicket(token: string): Promise<{ projectId: string; userId: string } | null> {
  if (!/^[A-Za-z0-9_-]{32}$/.test(token)) return null;
  const redis = await RedisManager.getWriter();
  const value = await redis.get(ticketKey(token));
  if (!value) return null;
  const ticket = JSON.parse(value) as { projectId?: unknown; userId?: unknown };
  return typeof ticket.projectId === "string" && typeof ticket.userId === "string"
    ? { projectId: ticket.projectId, userId: ticket.userId }
    : null;
}