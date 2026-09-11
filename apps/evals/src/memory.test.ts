import { describe, expect, test, beforeAll } from "bun:test";
import {
    getProjectMemories,
    renderPriorContext,
    saveChangeSummary,
    saveConversationMemory,
} from "@control/memory";

describe("multi-turn memory round-trip", () => {
    beforeAll(() => {
        process.env.EVAL_MODE = "1";
    });

    test("persists a structured change summary and reads it back", async () => {
        const projectId = `test-memory-${Date.now()}`;
        await saveConversationMemory(projectId, "Create a counter", "Counter added.");
        await saveChangeSummary(projectId, "Create a counter", {
            summary: "Created App.jsx with a useState counter.",
            filesCreated: ["src/App.jsx"],
            filesModified: [],
            filesDeleted: [],
            dependenciesAdded: [],
            dependenciesRemoved: [],
            buildStatus: "success",
        });

        const memories = await getProjectMemories(projectId);
        expect(memories.length).toBe(2);
        expect(memories.filter((m) => m.type === "change_summary").length).toBe(1);
        expect(memories.filter((m) => m.type === "conversation").length).toBe(1);
    });

    test("renders prior context as a compact actionable block", () => {
        const rendered = renderPriorContext([
            { type: "conversation", prompt: "hi", response: "hello there" },
            {
                type: "change_summary",
                prompt: "Create counter",
                changeSummary: {
                    summary: "Created a working counter.",
                    filesCreated: ["src/App.jsx"],
                    filesModified: ["src/index.css"],
                    filesDeleted: [],
                    dependenciesAdded: ["react"],
                    dependenciesRemoved: [],
                    buildStatus: "success",
                },
            },
        ]);
        expect(rendered).toContain("Created a working counter.");
        expect(rendered).toContain("src/App.jsx");
        expect(rendered).toContain("deps +[react]");
        expect(rendered).toContain("build success");
        expect(rendered).not.toContain("[object Object]");
    });

    test("renders an empty string for empty/malformed context", () => {
        expect(renderPriorContext([])).toBe("");
        expect(renderPriorContext(undefined)).toBe("");
        expect(renderPriorContext([null, "nope", 42])).toBe("");
    });
});