import { randomUUID } from "node:crypto";

type Waiter = {
    id: string;
    resolve: (value: string) => void;
    timer: ReturnType<typeof setTimeout>;
    expectedTypes?: string[];
};

/**
 * Correlates async stream responses with the HTTP request that initiated them
 * (spec-06 §1). Resolvers are keyed by `jobId` — not projectId — so concurrent
 * build/prompt/run operations for the same project each resolve with their own
 * matching response.
 *
 * Each waiter is tracked by a unique id so that timeout cleanup removes the
 * correct waiter instead of blindly shifting the first one.
 */
export class ResponseManager {
    private responses = new Map<string, Waiter[]>();

    wait(
        key: string,
        timeoutMs: number,
        expectedTypes?: string[],
    ): Promise<string> {
        const id = randomUUID();

        return new Promise<string>((resolve, reject) => {
            const timer = setTimeout(() => {
                this.removeWaiter(key, id);
                console.warn(
                    `[responseManager] Waiter ${id.slice(0, 8)} timed out for key ${key}`,
                );
                reject(new Error("TIMEOUT"));
            }, timeoutMs);

            const waiter: Waiter = {
                id,
                resolve: (value: string) => {
                    clearTimeout(timer);
                    resolve(value);
                },
                timer,
                expectedTypes,
            };

            const list = this.responses.get(key) ?? [];
            list.push(waiter);
            this.responses.set(key, list);
        });
    }

    resolve(key: string, value: string) {
        const list = this.responses.get(key);
        if (!list || list.length === 0) {
            console.warn(
                `[responseManager] No waiter for key ${key} — late response dropped`,
            );
            return;
        }

        let incomingType: string | undefined;
        try {
            incomingType = (JSON.parse(value) as { type?: string }).type;
        } catch {
            incomingType = undefined;
        }

        const index = list.findIndex((waiter) => {
            if (!waiter.expectedTypes || waiter.expectedTypes.length === 0) {
                return true;
            }
            return incomingType != null && waiter.expectedTypes.includes(incomingType);
        });

        if (index === -1) {
            console.warn(
                `[responseManager] Ignoring ${incomingType} for ${key} (no matching waiter)`,
            );
            return;
        }

        const [waiter] = list.splice(index, 1);
        if (list.length === 0) {
            this.responses.delete(key);
        } else {
            this.responses.set(key, list);
        }
        waiter?.resolve(value);
    }

    getActiveChannelsCount() {
        let count = 0;
        for (const list of this.responses.values()) {
            count += list.length;
        }
        return count;
    }

    private removeWaiter(key: string, waiterId: string) {
        const list = this.responses.get(key);
        if (!list) return;

        const index = list.findIndex((w) => w.id === waiterId);
        if (index === -1) return;

        list.splice(index, 1);
        if (list.length === 0) {
            this.responses.delete(key);
        } else {
            this.responses.set(key, list);
        }
    }
}

export const responseManager = new ResponseManager();
