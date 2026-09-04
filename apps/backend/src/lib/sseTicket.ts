import { randomBytes } from "node:crypto";

/**
 * Short-lived, reusable SSE connection tickets (spec-05 §5).
 *
 * EventSource can't send headers, so the browser historically embedded the
 * long-lived JWT in the URL query string, leaking it into logs and history.
 * Instead, the frontend mints an opaque, short-lived ticket via an
 * authenticated endpoint and passes ONLY that token in the query string.
 * The ticket stays valid until its TTL so EventSource reconnects can reuse it.
 */
export const SSE_TICKET_TTL_MS =
    Number(process.env.SSE_TICKET_TTL_MS || 60000);

type Ticket = {
    projectId: string;
    userId: string;
    expiresAt: number;
};

const tickets = new Map<string, Ticket>();

function purgeExpired(now: number) {
    for (const [token, ticket] of tickets) {
        if (ticket.expiresAt < now) {
            tickets.delete(token);
        }
    }
}

export function mintSseTicket(projectId: string, userId: string): string {
    purgeExpired(Date.now());
    const token = randomBytes(24).toString("base64url");
    tickets.set(token, {
        projectId,
        userId,
        expiresAt: Date.now() + SSE_TICKET_TTL_MS,
    });
    return token;
}

/**
 * Redeem a ticket. Returns the bound (projectId, userId) on success or null
 * when missing/expired. The ticket stays valid until it expires so that
 * EventSource auto-reconnects (which replay the same URL) can reuse it without
 * leaking the long-lived JWT into the query string.
 */
export function redeemSseTicket(
    token: string,
): { projectId: string; userId: string } | null {
    const ticket = tickets.get(token);
    if (!ticket) return null;

    if (ticket.expiresAt < Date.now()) {
        tickets.delete(token);
        return null;
    }

    return { projectId: ticket.projectId, userId: ticket.userId };
}
