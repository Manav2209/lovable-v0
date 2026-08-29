import fs from "fs";
import path from "path";
import { assertSafeProjectId } from "types";
import { sendSSEMessage } from "../../../sse";
import { resolveSafePath } from "../security";
import type { WorkflowState } from "../../graphs/workflow";

function projectDir(projectId: string): string {
    const sharedDir = process.env.SHARED_DIR || "/app/shared";
    return resolveSafePath(sharedDir, assertSafeProjectId(projectId));
}

function listPageComponents(srcDir: string): string[] {
    const componentsDir = path.join(srcDir, "components");
    if (!fs.existsSync(componentsDir)) return [];

    const skip = new Set(["ui"]);
    const files: string[] = [];

    for (const entry of fs.readdirSync(componentsDir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
            if (skip.has(entry.name)) continue;
            // features folders — collect nested tsx
            const nested = path.join(componentsDir, entry.name);
            for (const child of fs.readdirSync(nested)) {
                if (/\.(tsx|jsx)$/.test(child) && !child.startsWith(".")) {
                    files.push(`components/${entry.name}/${child}`);
                }
            }
            continue;
        }
        if (/\.(tsx|jsx)$/.test(entry.name) && !entry.name.startsWith(".")) {
            files.push(`components/${entry.name}`);
        }
    }

    const pagesDir = path.join(srcDir, "pages");
    if (fs.existsSync(pagesDir)) {
        for (const entry of fs.readdirSync(pagesDir)) {
            if (/\.(tsx|jsx)$/.test(entry) && !entry.startsWith(".")) {
                files.push(`pages/${entry}`);
            }
        }
    }

    return files.sort();
}

function componentNameFromFile(relPath: string): string {
    const base = path.basename(relPath).replace(/\.(tsx|jsx)$/, "");
    return base;
}

function appNeedsStitch(appContent: string, componentFiles: string[]): boolean {
    if (componentFiles.length === 0) return false;

    const looksLikeTemplate =
        /Hello World/i.test(appContent) ||
        (/<Button[^>]*>\s*Hello World\s*<\/Button>/i.test(appContent) &&
            componentFiles.length > 0);

    const missingImport = componentFiles.some((file) => {
        const name = componentNameFromFile(file);
        return !appContent.includes(name);
    });

    return looksLikeTemplate || missingImport;
}

function buildStitchedApp(componentFiles: string[]): string {
    // Prefer a dedicated page/landing component if present; otherwise compose sections.
    const pageLike = componentFiles.filter((f) =>
        /page|landing|home|onboarding/i.test(path.basename(f)),
    );
    const sections = componentFiles.filter((f) => !pageLike.includes(f));

    const imports: string[] = [`import './App.css'`];
    const body: string[] = [];

    for (const file of [...pageLike, ...sections]) {
        const name = componentNameFromFile(file);
        const importPath = `./${file.replace(/\\/g, "/").replace(/\.(tsx|jsx)$/, "")}`;
        imports.push(`import ${name} from '${importPath}'`);
    }

    if (pageLike.length > 0 && sections.length === 0) {
        // Single page component owns the UI
        const main = componentNameFromFile(pageLike[0]!);
        body.push(`      <${main} />`);
    } else if (pageLike.length > 0) {
        // Show onboarding/page first, then remaining sections (common landing pattern)
        for (const file of pageLike) {
            body.push(`      <${componentNameFromFile(file)} />`);
        }
        for (const file of sections) {
            body.push(`      <${componentNameFromFile(file)} />`);
        }
    } else {
        for (const file of sections) {
            body.push(`      <${componentNameFromFile(file)} />`);
        }
    }

    return `${imports.join("\n")}

function App() {
  return (
    <main className="min-h-screen bg-background text-foreground">
${body.join("\n")}
    </main>
  )
}

export default App
`;
}

/**
 * Ensures created page/section components are rendered from src/App.tsx.
 * LLMs often create components but leave the template Hello World App untouched.
 */
export async function stitchAppNode(
    state: WorkflowState,
): Promise<Partial<WorkflowState>> {
    const dir = projectDir(state.projectId);
    const srcDir = path.join(dir, "src");
    const appTsx = path.join(srcDir, "App.tsx");
    const appJsx = path.join(srcDir, "App.jsx");
    const appPath = fs.existsSync(appTsx)
        ? appTsx
        : fs.existsSync(appJsx)
          ? appJsx
          : appTsx;

    if (!fs.existsSync(srcDir)) {
        return {};
    }

    const componentFiles = listPageComponents(srcDir);
    if (componentFiles.length === 0) {
        return {};
    }

    const current = fs.existsSync(appPath)
        ? fs.readFileSync(appPath, "utf8")
        : "";

    if (!appNeedsStitch(current, componentFiles)) {
        sendSSEMessage(state.clientId, {
            type: "stitch_skipped",
            message: "App.tsx already references generated components",
        });
        return {};
    }

    sendSSEMessage(state.clientId, {
        type: "stitching",
        message: `Wiring ${componentFiles.length} component(s) into App.tsx…`,
    });

    const next = buildStitchedApp(componentFiles);
    fs.writeFileSync(appPath, next, "utf8");

    sendSSEMessage(state.clientId, {
        type: "stitch_complete",
        message: `Updated ${path.basename(appPath)} to render: ${componentFiles
            .map(componentNameFromFile)
            .join(", ")}`,
    });

    return {
        toolResults: [
            ...(state.toolResults || []),
            {
                toolCall: { tool: "stitchApp", args: { appPath } },
                result: { success: true, components: componentFiles },
            },
        ],
    };
}
