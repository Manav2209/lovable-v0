type Waiter = {
    resolve: (value: string) => void;
    expectedTypes?: string[];
};

export class ResponseManager {
    private responses = new Map<string, Waiter[]>();

    setChannel(projectId: string, waiter: Waiter) {
        const list = this.responses.get(projectId) ?? [];
        list.push(waiter);
        this.responses.set(projectId, list);
        console.log(`Set response channel for project ${projectId}`);
    }

    cleanupChannel(projectId: string) {
        const list = this.responses.get(projectId);
        if (!list || list.length === 0) {
            return;
        }
        list.shift();
        if (list.length === 0) {
            this.responses.delete(projectId);
        } else {
            this.responses.set(projectId, list);
        }

        console.log(`Cleaned up channel for project ${projectId}`);
    }

    getActiveChannelsCount() {
        let count = 0;
        for (const list of this.responses.values()) {
            count += list.length;
        }
        return count;
    }

    resolve(projectId: string, value: string) {
        const list = this.responses.get(projectId);
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
                `[responseManager] Ignoring ${incomingType} for ${projectId} (no matching waiter)`,
            );
            return;
        }

        const [waiter] = list.splice(index, 1);
        if (list.length === 0) {
            this.responses.delete(projectId);
        } else {
            this.responses.set(projectId, list);
        }
        waiter?.resolve(value);
    }

    wait(
        projectId: string,
        timeoutMs: number,
        expectedTypes?: string[],
    ): Promise<string> {
        return new Promise((resolve, reject) => {
            const timer = setTimeout(() => {
                this.cleanupChannel(projectId);
                reject(new Error("TIMEOUT"));
            }, timeoutMs);

            this.setChannel(projectId, {
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
