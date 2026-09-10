import { describe, expect, test } from "bun:test";
import { sanitizeForObservability } from "@control/observability/sanitize";

describe("sanitizeForObservability", () => {
    test("redacts secret-shaped keys", () => {
        const out = sanitizeForObservability({
            GROQ_API_KEY: "abc",
            filePath: "src/App.jsx",
        }) as Record<string, unknown>;
        expect(out.GROQ_API_KEY).toBe("[redacted]");
        expect(out.filePath).toBe("src/App.jsx");
    });

    test("omits bulky file bodies", () => {
        const out = sanitizeForObservability({
            content: "x".repeat(50),
            hash: "deadbeef",
        }) as Record<string, unknown>;
        expect(String(out.content)).toContain("omitted 50 chars");
        expect(out.hash).toBe("deadbeef");
    });

    test("redacts bearer tokens in strings", () => {
        expect(sanitizeForObservability("Bearer abcdefghijklmnop")).toBe("[redacted]");
    });
});
