import fs from "fs";
import path from "path";

export interface SeededWorkspace {
    /** Value to assign to process.env.SHARED_DIR for this case. */
    sharedDir: string;
    projectDir: string;
    projectId: string;
    /** The ws-* parent directory created for this case; removed during run cleanup. */
    workspaceDir: string;
}

const TEMPLATE_DIR = path.resolve(import.meta.dir, "..", "..", "..", "template");

const EXCLUDED = new Set(["node_modules", "dist", ".git", ".turbo"]);

/**
 * Packages that must never exist physically in the shared template store:
 * they are placeholder registrations the agent sometimes installs via bun add,
 * which writes through the node_modules junction into apps/template and breaks
 * builds for every subsequent case. Prune them before seeding so one bad case
 * can't poison the whole run.
 */
const SHARED_STORE_POLLUTION = new Set(["@shadcn"]);

async function pruneSharedStorePollution(templateDir: string): Promise<void> {
    const nmDir = path.join(templateDir, "node_modules");
    if (!fs.existsSync(nmDir)) return;
    for (const marker of SHARED_STORE_POLLUTION) {
        const target = path.join(nmDir, marker);
        if (fs.existsSync(target)) {
            console.warn(`[seedWorkspace] Pruning shared-store pollution "${marker}" from ${nmDir}`);
            await fs.promises.rm(target, { recursive: true, force: true });
        }
    }
}

/**
 * Mirrors production layout: control tools resolve every path as
 * `SHARED_DIR/PROJECT_ID`, so a seeded run gets
 * `<tempBase>/shared/<projectId>` populated from apps/template — the same
 * files the pod would pull from R2.
 *
 * Node_modules are junctioned (instant, zero disk) from the template so
 * bun install is essentially a no-op verification rather than a cold fetch.
 */
export async function seedWorkspace(
    runDir: string,
    caseId: string,
    options?: { fixture?: string },
): Promise<SeededWorkspace> {
    const base = await fs.promises.mkdtemp(path.join(runDir, "ws-"));
    const sharedDir = path.join(base, "shared");
    const projectId = `eval-${caseId}-${Date.now().toString(36)}`;
    const projectDir = path.join(sharedDir, projectId);

    await fs.promises.mkdir(projectDir, { recursive: true });
    await copyDir(TEMPLATE_DIR, projectDir);

    if (options?.fixture) {
        const fixtureDir = path.resolve(import.meta.dir, "..", "..", "fixtures", options.fixture);
        if (!fs.existsSync(fixtureDir)) {
            throw new Error(`Eval fixture not found: ${fixtureDir}`);
        }
        await copyDir(fixtureDir, projectDir);
    }

    // Symlink template's pre-installed node_modules into the workspace.
    await pruneSharedStorePollution(TEMPLATE_DIR);
    const templateNM = path.join(TEMPLATE_DIR, "node_modules");
    const targetNM = path.join(projectDir, "node_modules");
    try {
        await fs.promises.symlink(templateNM, targetNM, "junction");
    } catch {
        // Fallback: if symlink fails (e.g. permissions), bun install will run.
        // Slow but still works.
    }

    return { sharedDir, projectDir, projectId, workspaceDir: base };
}

/**
 * Removes all ws-* workspace directories under a run, keeping the run's
 * manifest.json, events.jsonl, results/, and report.md intact.
 * Call in index.ts after report generation so M6 AST checks can still
 * read the generated project files during the run itself.
 */
export async function cleanupRunWorkspaces(runDir: string): Promise<void> {
    const entries = await fs.promises.readdir(runDir, { withFileTypes: true });
    await Promise.all(
        entries
            .filter((e) => e.isDirectory() && e.name.startsWith("ws-"))
            .map((e) => fs.promises.rm(path.join(runDir, e.name), { recursive: true, force: true })),
    );
}

/** Removes an entire run directory (used by --clean for stale run dirs). */
export async function cleanupRunDir(runDir: string): Promise<void> {
    await fs.promises.rm(runDir, { recursive: true, force: true });
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
