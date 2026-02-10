export class ResponseManager {

    // projectId , [{response}]
    private responses = new Map<string, Array<(value: string) => void>>();

    setChannel(projectId: string, resolver: (value: string) => void) {
        const list = this.responses.get(projectId) ?? [];
        list.push(resolver);
        this.responses.set(projectId, list);
        console.log(`Set response channel for project ${projectId}`);
    }

    getAndDelete(projectId: string):((value: string) => void) | undefined {
    
        const list = this.responses.get(projectId);
        if (!list || list.length === 0) {
            return undefined;
        }
    
        const resolver = list.shift()!;
    
        if (list.length === 0) {
            this.responses.delete(projectId);
        } else {
            this.responses.set(projectId, list);
        }
    
        return resolver;
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
        const resolver = this.getAndDelete(projectId);
        if (!resolver) return;
    
        resolver(value);
    }

    wait(projectId: string, timeoutMs: number): Promise<string> {
        return new Promise((resolve, reject) => {
    
        const timer = setTimeout(() => {
            this.cleanupChannel(projectId);
            reject(new Error("TIMEOUT"));
        }, timeoutMs);
    
        this.setChannel(projectId, (value: string) => {
            clearTimeout(timer);
            resolve(value);
        });
    
        });
        }
    }
    