import { AsyncLocalStorage } from "node:async_hooks";
import path from "path";
import { assertSafeProjectId } from "types";

export type AgentRuntime = {
    projectId: string;
    projectDir: string;
    abortSignal: AbortSignal;
};

const storage = new AsyncLocalStorage<AgentRuntime>();

export function getAgentRuntime(): AgentRuntime | undefined {
    return storage.getStore();
}

export function requireAgentRuntime(): AgentRuntime {
    const runtime = storage.getStore();
    if (!runtime) {
        throw new Error("AgentRuntime is not set for this request");
    }
    return runtime;
}

export function createAgentRuntime(
    projectId: string,
    abortSignal?: AbortSignal,
): AgentRuntime {
    const id = assertSafeProjectId(projectId);
    const sharedDir = process.env.SHARED_DIR || "/app/shared";
    return {
        projectId: id,
        projectDir: path.resolve(sharedDir, id),
        abortSignal: abortSignal ?? new AbortController().signal,
    };
}

export function runWithAgentRuntime<T>(
    runtime: AgentRuntime,
    fn: () => T,
): T {
    return storage.run(runtime, fn);
}
