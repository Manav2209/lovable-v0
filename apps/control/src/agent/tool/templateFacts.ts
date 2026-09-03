import fs from "fs";
import path from "path";
import { glob } from "glob";
import { IGNORE_PATTERNS } from "./simple/getContext";
import { getProjectDir } from "./security";
import { sendSSEMessage } from "../../sse";
import type { WorkflowState } from "../graphs/workflow";

export type TemplateFacts = {
    framework: "react";
    buildTool: "vite";
    language: "javascript" | "typescript";
    styling: "tailwind" | "unknown";
    componentLibrary: "shadcn" | "unknown";
    packageManager: "bun" | "npm";
    entryPoints: { main: string; app: string };
    directories: {
        components: string;
        pages?: string;
        hooks?: string;
        lib?: string;
    };
};

function firstExisting(root: string, candidates: string[]): string | undefined {
    return candidates.find((rel) => fs.existsSync(path.join(root, rel)));
}

export function collectTemplateFacts(projectDir: string): TemplateFacts {
    const pkgPath = path.join(projectDir, "package.json");
    let pkg: Record<string, unknown> = {};
    try {
        pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
    } catch {
        /* missing or invalid */
    }

    const deps = {
        ...((pkg.dependencies as Record<string, string>) || {}),
        ...((pkg.devDependencies as Record<string, string>) || {}),
    };

    const main =
        firstExisting(projectDir, ["src/main.jsx", "src/main.tsx", "src/main.js", "src/main.ts"]) ||
        "src/main.jsx";
    const app =
        firstExisting(projectDir, ["src/App.jsx", "src/App.tsx", "src/App.js", "src/App.ts"]) ||
        "src/App.jsx";

    const language: TemplateFacts["language"] =
        main.endsWith(".tsx") || main.endsWith(".ts") || app.endsWith(".tsx") || app.endsWith(".ts")
            ? "typescript"
            : "javascript";

    const directories: TemplateFacts["directories"] = {
        components: fs.existsSync(path.join(projectDir, "src/components"))
            ? "src/components"
            : "src",
    };
    if (fs.existsSync(path.join(projectDir, "src/pages"))) directories.pages = "src/pages";
    if (fs.existsSync(path.join(projectDir, "src/hooks"))) directories.hooks = "src/hooks";
    if (fs.existsSync(path.join(projectDir, "src/lib"))) directories.lib = "src/lib";

    return {
        framework: "react",
        buildTool: "vite",
        language,
        styling: "tailwind" in deps || Object.keys(deps).some((k) => k.includes("tailwind"))
            ? "tailwind"
            : "unknown",
        componentLibrary: fs.existsSync(path.join(projectDir, "components.json")) ? "shadcn" : "unknown",
        packageManager: fs.existsSync(path.join(projectDir, "bun.lock")) || fs.existsSync(path.join(projectDir, "bun.lockb"))
            ? "bun"
            : "npm",
        entryPoints: { main, app },
        directories,
    };
}

export async function collectFileTree(projectDir: string): Promise<string> {
    const files = await glob("**/*", {
        cwd: projectDir,
        nodir: true,
        absolute: false,
        ignore: IGNORE_PATTERNS,
        dot: false,
    });
    return files.sort().slice(0, 400).join("\n");
}

export async function collectWorkspaceFactsNode(
    state: WorkflowState,
): Promise<Partial<WorkflowState>> {
    sendSSEMessage(state.clientId, {
        type: "collecting_facts",
        message: "Inspecting pulled template on disk...",
    });

    const projectDir = getProjectDir();
    const templateFacts = collectTemplateFacts(projectDir);
    const fileTree = await collectFileTree(projectDir);

    sendSSEMessage(state.clientId, {
        type: "facts_ready",
        message: `Template is ${templateFacts.language} (${templateFacts.entryPoints.app})`,
    });

    return { templateFacts, fileTree };
}
