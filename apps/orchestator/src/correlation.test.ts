import { describe, expect, it } from "bun:test";
import { CorrelationResolver, idKey } from "./correlation";

type Msg = { projectId: string; jobId?: string; type: string };

describe("idKey", () => {
    it("prefers jobId when present", () => {
        expect(idKey("proj-a", "job-1")).toBe("job-1");
    });

    it("falls back to projectId when jobId is absent/empty", () => {
        expect(idKey("proj-a")).toBe("proj-a");
        expect(idKey("proj-a", "")).toBe("proj-a");
        expect(idKey("proj-a", undefined)).toBe("proj-a");
    });
});

describe("CorrelationResolver (spec-06 §1 regression)", () => {
    it("resolves two concurrent waits for the same project with their own jobId-keyed responses", async () => {
        const resolver = new CorrelationResolver<Msg>();

        const commit = (v: Msg) => {
            // Mirror of production behavior: resolve by jobId -> projectId fallback.
            return resolver.resolve(idKey(v.projectId, v.jobId), v);
        };

        const p1 = resolver.wait(idKey("proj-a", "job-1"), 1000, "Control pod");
        const p2 = resolver.wait(idKey("proj-a", "job-2"), 1000, "Control pod");

        // Two concurrent in-flight requests for the same project must coexist.
        expect(commit({ projectId: "proj-a", jobId: "job-2", type: "BUILD_SUCCESS" })).toBe(
            true,
        );
        expect(commit({ projectId: "proj-a", jobId: "job-1", type: "PROMPT_RESPONSE" })).toBe(
            true,
        );

        const [r1, r2] = await Promise.all([p1, p2]);
        expect(r1.jobId).toBe("job-1");
        expect(r1.type).toBe("PROMPT_RESPONSE");
        expect(r2.jobId).toBe("job-2");
        expect(r2.type).toBe("BUILD_SUCCESS");
    });

    it("does not cross-resolve a waiter keyed by a different jobId for the same project", async () => {
        const resolver = new CorrelationResolver<Msg>();

        const other = resolver.wait(idKey("proj-a", "job-b"), 1000, "Control pod");
        // A response for an unrelated jobId of the same project must not resolve it.
        expect(resolver.resolve(idKey("proj-a", "job-other"), { projectId: "proj-a", type: "X" })).toBe(
            false,
        );
        // The matching response resolves it.
        resolver.resolve(idKey("proj-a", "job-b"), { projectId: "proj-a", jobId: "job-b", type: "OK" });
        expect((await other).type).toBe("OK");
    });

    it("projectId fallback still works when no jobId is involved", async () => {
        const resolver = new CorrelationResolver<Msg>();
        const wait = resolver.wait(idKey("legacy-proj"), 1000, "Control pod");
        resolver.resolve(idKey("legacy-proj"), { projectId: "legacy-proj", type: "R" });
        expect((await wait).type).toBe("R");
    });

    it("reports a late reply (no waiter) as a miss and resolves nothing", async () => {
        const resolver = new CorrelationResolver<Msg>();
        expect(
            resolver.resolve(idKey("proj-a", "ghost-job"), { projectId: "proj-a", type: "X" }),
        ).toBe(false);
    });
});
