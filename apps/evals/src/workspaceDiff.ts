import fs from "fs";
import path from "path";
import { createHash } from "node:crypto";
import type { WorkspaceDiff } from "./agentRun";

const SKIP = new Set(["node_modules", "dist", ".git", ".turbo"]);

export async function snapshotWorkspace(projectDir: string): Promise<Map<string, string>> {
    const out = new Map<string, string>();
    await walk(projectDir, projectDir, out);
    return out;
}

export function diffSnapshots(
    before: Map<string, string>,
    after: Map<string, string>,
): WorkspaceDiff {
    const created: string[] = [];
    const modified: string[] = [];
    const deleted: string[] = [];

    for (const [rel, hash] of after) {
        const prev = before.get(rel);
        if (prev === undefined) created.push(rel);
        else if (prev !== hash) modified.push(rel);
    }
    for (const rel of before.keys()) {
        if (!after.has(rel)) deleted.push(rel);
    }

    created.sort();
    modified.sort();
    deleted.sort();
    return { created, modified, deleted };
}

async function walk(root: string, dir: string, out: Map<string, string>): Promise<void> {
    let entries: fs.Dirent[];
    try {
        entries = await fs.promises.readdir(dir, { withFileTypes: true });
    } catch {
        return;
    }
    for (const entry of entries) {
        if (SKIP.has(entry.name)) continue;
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            await walk(root, full, out);
            continue;
        }
        if (!entry.isFile()) continue;
        const rel = path.relative(root, full).replaceAll("\\", "/");
        const buf = await fs.promises.readFile(full);
        out.set(rel, createHash("sha256").update(buf).digest("hex").slice(0, 16));
    }
}
