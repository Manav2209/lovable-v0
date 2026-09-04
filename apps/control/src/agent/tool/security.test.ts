import { describe, expect, it } from "bun:test";
import fs from "fs";
import os from "os";
import path from "path";
import { assertSafeProjectId } from "types";
import { resolveSafePath } from "./security";

function makeBaseDir(): string {
    return fs.mkdtempSync(path.join(os.tmpdir(), "safepath-"));
}

describe("resolveSafePath", () => {
    it("accepts a valid nested path inside the base", () => {
        const base = makeBaseDir();
        expect(resolveSafePath(base, "src", "App.tsx")).toBe(
            path.resolve(base, "src", "App.tsx"),
        );
    });

    it("accepts the base itself", () => {
        const base = makeBaseDir();
        expect(resolveSafePath(base)).toBe(path.resolve(base));
    });

    it("does not create the directory on resolve", () => {
        const base = makeBaseDir();
        resolveSafePath(base, "not", "created");
        expect(fs.existsSync(path.join(base, "not", "created"))).toBe(false);
    });

    it("rejects ../ traversal", () => {
        const base = makeBaseDir();
        expect(() => resolveSafePath(base, "..", "secret")).toThrow(
            /escapes project directory/,
        );
        expect(() => resolveSafePath(base, "src", "..", "..", "secret")).toThrow(
            /escapes project directory/,
        );
    });

    it("rejects absolute path escapes", () => {
        const base = makeBaseDir();
        expect(() =>
            resolveSafePath(base, path.resolve(os.tmpdir(), "elsewhere")),
        ).toThrow(/escapes project directory/);
    });

    it("rejects traversal through an existing directory", () => {
        const base = makeBaseDir();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
        // Implant a file outside, then try to reach it via ..
        fs.writeFileSync(path.join(base, "sub"), "subdir? no", "utf8");
        fs.rmSync(path.join(base, "sub"));
        fs.mkdirSync(path.join(base, "sub"));
        expect(() => resolveSafePath(base, "sub", "..", "..", "secret")).toThrow(
            /escapes project directory/,
        );
        void outside;
    });

    it("rejects symlink escapes pointing outside the sandbox", () => {
        const base = makeBaseDir();
        const outside = fs.mkdtempSync(path.join(os.tmpdir(), "outside-"));
        const link = path.join(base, "link");

        let created = false;
        try {
            fs.symlinkSync(outside, link, "junction");
            created = true;
        } catch {
            // Symlinks not permitted in this environment; skip.
        }
        if (!created) return;

        // Reading through the link resolves to the outside directory.
        expect(() => resolveSafePath(base, "link", "file.txt")).toThrow(
            /escapes project directory via symlink/,
        );
    });

    it("accepts a path whose nearest existing ancestor is inside the sandbox", () => {
        const base = makeBaseDir();
        fs.mkdirSync(path.join(base, "existing"), { recursive: true });
        // The final file does not exist yet, but its parent is inside the base.
        expect(resolveSafePath(base, "existing", "new.txt")).toBe(
            path.resolve(base, "existing", "new.txt"),
        );
    });
});

describe("assertSafeProjectId", () => {
    it("accepts a plain project id", () => {
        expect(assertSafeProjectId("proj_abc-123.xyz")).toBe("proj_abc-123.xyz");
    });

    it("rejects an empty id", () => {
        expect(() => assertSafeProjectId("")).toThrow(/Invalid project id/);
    });

    it("rejects path separator traversal", () => {
        expect(() => assertSafeProjectId("a/b")).toThrow(/Invalid project id/);
        expect(() => assertSafeProjectId("..\\etc")).toThrow(/Invalid project id/);
    });

    it("rejects .. escapes", () => {
        expect(() => assertSafeProjectId("a..b")).toThrow(/Invalid project id/);
    });

    it("rejects leading or trailing dots", () => {
        expect(() => assertSafeProjectId(".hidden")).toThrow(/Invalid project id/);
        expect(() => assertSafeProjectId("trailing.")).toThrow(/Invalid project id/);
    });

    it("rejects ids longer than 128 chars", () => {
        expect(() => assertSafeProjectId("x".repeat(129))).toThrow(
            /Invalid project id/,
        );
    });

    it("rejects non-allowlisted characters", () => {
        expect(() => assertSafeProjectId("sp ace")).toThrow(/Invalid project id/);
        expect(() => assertSafeProjectId("semi;colon")).toThrow(/Invalid project id/);
    });
});
