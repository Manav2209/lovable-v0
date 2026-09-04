type Waiter = {
    resolve: (value: string) => void;
    expectedTypes?: string[];
};

/**
 * Correlates async stream responses with the HTTP request that initiated them
 * (spec-06 §1). Resolvers are keyed by `jobId` — not projectId — so concurrent
 * build/prompt/run operations for the same project each resolve with their own
 * matching response.
 */
export class ResponseManager {
    private responses = new Map<string, Waiter[]>();

    setChannel(key: string, waiter: Waiter) {
        const list = this.responses.get(key) ?? [];
        list.push(waiter);
        this.responses.set(key, list);
        console.log(`Set response channel for key ${key}`);
    }

    cleanupChannel(key: string) {
        const list = this.responses.get(key);
        if (!list || list.length === 0) {
            return;
        }
        list.shift();
        if (list.length === 0) {
            this.responses.delete(key);
        } else {
            this.responses.set(key, list);
        }

        console.log(`Cleaned up channel for key ${key}`);
    }

    getActiveChannelsCount() {
        let count = 0;
        for (const list of this.responses.values()) {
            count += list.length;
        }
        return count;
    }

    resolve(key: string, value: string) {
        const list = this.responses.get(key);
        if (!list || list.length === 0) return;

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
            console.log(
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

    wait(
        key: string,
        timeoutMs: number,
        expectedTypes?: string[],
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.cleanupChannel(key);
                reject(new Error("TIMEOUT"));
            }, timeoutMs);

            this.setChannel(key, {
                expectedTypes,
                resolve: (value: string) => {
                    clearTimeout(timer);
                    resolve(value);
                },
            });
        });
    }
}

export const responseManager = new ResponseManager();
