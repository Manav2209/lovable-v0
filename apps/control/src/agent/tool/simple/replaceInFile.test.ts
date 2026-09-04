import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { replaceInFile } from "./replaceInFile";
import type { ToolResult } from "../result";

let sandbox: string;
let projectDir: string;

function writeFile(rel: string, content: string): string {
    const p = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, content, "utf8");
    return p;
}

function readFile(rel: string): string {
    return fs.readFileSync(path.join(projectDir, rel), "utf8");
}

function asResult(r: unknown): ToolResult {
    return r as ToolResult;
}

describe("replaceInFile (spec-06 §3 file-tool safety)", () => {
    beforeAll(() => {
        sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "patchtool-"));
        projectDir = path.join(sandbox, "proj");
        fs.mkdirSync(projectDir, { recursive: true });
        process.env.SHARED_DIR = sandbox;
        process.env.PROJECT_ID = "proj";
    });

    afterAll(() => {
        fs.rmSync(sandbox, { recursive: true, force: true });
        delete process.env.SHARED_DIR;
        delete process.env.PROJECT_ID;
    });

    it("replaces a single unique match and reports changes: 1", async () => {
        writeFile("a.txt", "hello world hello");
        const res = asResult(
            await replaceInFile.invoke({
                filePath: "a.txt",
                oldString: "world",
                newString: "there",
            }),
        );
        expect(res.success).toBe(true);
        expect((res.data as { changes: number }).changes).toBe(1);
        expect(readFile("a.txt")).toBe("hello there hello");
    });

    it("does NOT silently report changes: 1 when a string matches multiple times without replaceAll", async () => {
        writeFile("b.txt", "app==app==app");
        const before = readFile("b.txt");
        const res = asResult(
            await replaceInFile.invoke({
                filePath: "b.txt",
                oldString: "app",
                newString: "x",
            }),
        );
        // Regression for the live-broken case: must fail, not report changes: 1.
        expect(res.success).toBe(false);
        expect(res.message).toMatch(/Found 3 matches/);
        expect(readFile("b.txt")).toBe(before); // unchanged
    });

    it("replaces every occurrence when replaceAll is set", async () => {
        writeFile("c.txt", "app==app==app");
        const res = asResult(
            await replaceInFile.invoke({
                filePath: "c.txt",
                oldString: "app",
                newString: "x",
                replaceAll: true,
            }),
        );
        expect(res.success).toBe(true);
        expect((res.data as { changes: number }).changes).toBe(3);
        expect(readFile("c.txt")).toBe("x==x==x");
    });

    it("fails cleanly when the string is absent", async () => {
        writeFile("d.txt", "nothing here");
        const res = asResult(
            await replaceInFile.invoke({
                filePath: "d.txt",
                oldString: "missing",
                newString: "x",
            }),
        );
        expect(res.success).toBe(false);
        expect(res.message).toMatch(/String not found/);
    });

    it("fails cleanly when the file does not exist", async () => {
        const res = asResult(
            await replaceInFile.invoke({
                filePath: "nope.txt",
                oldString: "a",
                newString: "b",
            }),
        );
        expect(res.success).toBe(false);
        expect(res.message).toMatch(/does not exist/);
    });
});
