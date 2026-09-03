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

    // Only auto-compose App (jsx/tsx) when it is still the untouched template.
    // If the agent already composed components into App, trust it — blindly
    // rendering every section without required props (e.g. `tasks`, `services`,
    // `onAdd`) causes runtime crashes / whitescreens.
    const looksLikeTemplate =
        /Hello World/i.test(appContent) ||
        (/<Button[^>]*>\s*Hello World\s*<\/Button>/i.test(appContent) &&
            componentFiles.length > 0);

    return looksLikeTemplate;
}

/** Extract destructured prop names from a React function component's signature. */
function extractProps(filePath: string): string[] {
    try {
        const src = fs.readFileSync(filePath, "utf8");
        // Matches: function Name({ a, b, c = ..., ...rest }) {  OR  const Name = ({ a, b }) => (
        const m = src.match(/(?:function\s+\w+|const\s+\w+\s*=\s*)\(?\{([^}]*)\}\)?\s*(?:=>|\{)/);
        const group = m?.[1];
        if (!group) return [];
        return group
            .split(",")
            .map((p) => p.trim())
            .map((p) => (p.split(":")[0] ?? p).trim().replace(/^\.\.\./, ""))
            .filter(Boolean)
            .filter((p) => p !== "className" && p !== "children");
    } catch {
        return [];
    }
}

const LIST_LIKE = /^(items|data|list|lists|todos|tasks|tasksList|projects|results|people|users|services)$/i;
const ADD_HANDLER = /^onAdd|^onCreate|^addItem|^handleAdd/i;
const DELETE_HANDLER = /^onDelete|^onRemove|^handleDelete|^handleRemove|^onRemoveItem/i;

/** Build a functional, white-screen-proof App that wires common list/CRUD props. */
function buildStitchedApp(componentFiles: string[], srcDir: string): string {
    // Prefer a dedicated page/landing component if present; otherwise compose sections.
    const pageLike = componentFiles.filter((f) =>
        /page|landing|home|onboarding/i.test(path.basename(f)),
    );
    const sections = componentFiles.filter((f) => !pageLike.includes(f));

    const imports: string[] = [`import './App.css'`];
    const entries: { name: string; props: string[]; file: string }[] = [];

    for (const file of [...pageLike, ...sections]) {
        const name = componentNameFromFile(file);
        const importPath = `./${file.replace(/\\/g, "/").replace(/\.(tsx|jsx)$/, "")}`;
        imports.push(`import ${name} from '${importPath}'`);
        entries.push({ name, props: extractProps(path.join(srcDir, file)), file });
    }

    const body: string[] = [];
    const setup: string[] = [];

    // Provide state for the first list-like prop found across components.
    const listEntry = entries.find((e) => e.props.some((p) => LIST_LIKE.test(p)));
    const listProp = listEntry?.props.find((p) => LIST_LIKE.test(p));
    const addHandler = entries.flatMap((e) =>
        e.props.filter((p) => ADD_HANDLER.test(p)).map((p) => ({ comp: e.name, prop: p })),
    );
    const deleteHandler = entries.flatMap((e) =>
        e.props.filter((p) => DELETE_HANDLER.test(p)).map((p) => ({ comp: e.name, prop: p })),
    );

    let itemsVar = "[]";
    let hasState = false;
    if (listEntry && listProp) {
        setup.push(`  const [items, setItems] = useState([]);`);
        itemsVar = "items";
        hasState = true;
    } else if (addHandler.length > 0 || deleteHandler.length > 0) {
        // No list prop found but handlers exist -> still need state + handlers.
        setup.push(`  const [items, setItems] = useState([]);`);
        itemsVar = "items";
        hasState = true;
    }

    if (hasState) {
        if (addHandler.length > 0) {
            setup.push(`  const handleAdd = (val) => { if (!val) return; setItems((prev) => [...prev, val]); };`);
        } else {
            setup.push(`  const handleAdd = () => {};`);
        }
        if (deleteHandler.length > 0) {
            setup.push(`  const handleDelete = (index) => setItems((prev) => prev.filter((_, i) => i !== index));`);
        } else {
            setup.push(`  const handleDelete = () => {};`);
        }
    }

    // Explicitly wire the primary add/delete components first.
    if (addHandler.length > 0) {
        const { comp, prop } = addHandler[0]!;
        body.push(`      <${comp} ${prop}={handleAdd} />`);
    }
    if (deleteHandler.length > 0) {
        const { comp, prop } = deleteHandler[0]!;
        body.push(`      <${comp} ${prop}={handleDelete} />`);
    }

    for (const entry of entries) {
        const alreadyRendered = body.some((l) => l.includes(`<${entry.name} `) || l.includes(`<${entry.name}/>`));
        if (alreadyRendered) continue;

        const attrs = entry.props
            .map((prop) => {
                if (LIST_LIKE.test(prop)) return `${prop}={${itemsVar}}`;
                if (ADD_HANDLER.test(prop)) return `${prop}={handleAdd}`;
                if (DELETE_HANDLER.test(prop)) return `${prop}={handleDelete}`;
                if (/^on[A-Z]/.test(prop)) return `${prop}={() => {}}`;
                return "";
            })
            .filter(Boolean)
            .join(" ");
        body.push(`      <${entry.name} ${attrs.trim()} />`.replace(/\s+>/g, ">"));
    }

    if (hasState) imports.push(`import { useState } from 'react'`);

    const stateBlock = setup.length ? `${setup.join("\n")}\n\n` : "";

    return `${imports.join("\n")}

function App() {
${stateBlock}  return (
    <main className="min-h-screen bg-background text-foreground">
${body.join("\n")}
    </main>
  )
}

export default App
`;
}

/**
 * Ensures created page/section components are rendered from src/App (.jsx/.tsx).
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
            message: "App already references generated components",
        });
        return {};
    }

    sendSSEMessage(state.clientId, {
        type: "stitching",
        message: `Wiring ${componentFiles.length} component(s) into App…`,
    });

    const next = buildStitchedApp(componentFiles, srcDir);
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
