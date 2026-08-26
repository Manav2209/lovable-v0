import fs from "fs";
import path from "path";

export interface SeededWorkspace {
    /** Value to assign to process.env.SHARED_DIR for this case. */
    sharedDir: string;
    projectDir: string;
    projectId: string;
}

const TEMPLATE_DIR = path.resolve(import.meta.dir, "..", "..", "..", "template");

const EXCLUDED = new Set(["node_modules", "dist", ".git", ".turbo"]);

/**
 * Mirrors production layout: control tools resolve every path as
 * `SHARED_DIR/PROJECT_ID`, so a seeded run gets
 * `<tempBase>/shared/<projectId>` populated from apps/template — the same
 * files the pod would pull from R2.
 *
 * Node_modules are junctioned (instant, zero disk) from the template so
 * bun install is essentially a no-op verification rather than a cold fetch.
 */
export async function seedWorkspace(runDir: string, caseId: string): Promise<SeededWorkspace> {
    const base = await fs.promises.mkdtemp(path.join(runDir, "ws-"));
    const sharedDir = path.join(base, "shared");
    const projectId = `eval-${caseId}-${Date.now().toString(36)}`;
    const projectDir = path.join(sharedDir, projectId);

    await fs.promises.mkdir(projectDir, { recursive: true });
    await copyDir(TEMPLATE_DIR, projectDir);

    // Symlink template's pre-installed node_modules into the workspace.
    const templateNM = path.join(TEMPLATE_DIR, "node_modules");
    const targetNM = path.join(projectDir, "node_modules");
    try {
        await fs.promises.symlink(templateNM, targetNM, "junction");
    } catch {
        // Fallback: if symlink fails (e.g. permissions), bun install will run.
        // Slow but still works.
    }

    return { sharedDir, projectDir, projectId };
}

async function copyDir(src: string, dest: string): Promise<void> {
    const entries = await fs.promises.readdir(src, { withFileTypes: true });

    for (const entry of entries) {
        if (EXCLUDED.has(entry.name)) continue;

        const srcPath = path.join(src, entry.name);
        const destPath = path.join(dest, entry.name);

        if (entry.isDirectory()) {
            await fs.promises.mkdir(destPath, { recursive: true });
            await copyDir(srcPath, destPath);
        } else {
            await fs.promises.copyFile(srcPath, destPath);
        }
    }
}
