import fs from "fs";
import path from "path";
import { parse, type ParserOptions } from "@babel/parser";
import traverse, { type NodePath } from "@babel/traverse";
import type * as t from "@babel/types";

/**
 * Structural analysis of a generated project using Babel.
 * Supports the `ast:` assertion prefix alongside grep/file/dep checks.
 *
 * Check syntax:
 *   ast:import:<mod>                   module imported whose source matches
 *   ast:import:<mod>:<name>            named/local import binding name
 *   ast:jsx:<Element>                  JSX element/component name present
 *   ast:jsx:input:attr:<attr>          JSX element with a given attribute
 *   ast:hook:<hookName>                real hook call (Identifier starting with `use`)
 *   ast:component:<Name>               a component function/const named <Name> defined
 *   ast:exports:<Name>                 named export of a declaration named <Name>
 */

export interface SourceFileInfo {
    file: string;
    imports: Map<string, Set<string>>; // module -> imported/local names
    jsxElements: Map<string, string[]>; // element name -> attribute names used
    hooks: Set<string>; // hook identifiers called
    components: Set<string>; // defined component names
    exports: Set<string>; // named exports (declaration names)
}

export type AstIndex = Map<string, SourceFileInfo>;

const tsxParser: ParserOptions = {
    sourceType: "module",
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: [
        "jsx",
        "typescript",
        "classProperties",
        "classPrivateProperties",
        "classPrivateMethods",
        "objectRestSpread",
        "optionalChaining",
        "nullishCoalescingOperator",
        "dynamicImport",
        "topLevelAwait",
        "decorators-legacy",
    ] as unknown as NonNullable<ParserOptions["plugins"]>,
};

const jsParser: ParserOptions = {
    sourceType: "module",
    allowImportExportEverywhere: true,
    allowReturnOutsideFunction: true,
    errorRecovery: true,
    plugins: [
        "jsx",
        "classProperties",
        "objectRestSpread",
        "optionalChaining",
        "nullishCoalescingOperator",
        "dynamicImport",
        "topLevelAwait",
    ] as unknown as NonNullable<ParserOptions["plugins"]>,
};

function parseOrNull(
    content: string,
    file: string,
): t.File | null {
    try {
        const opts = /\.(tsx?)$/i.test(file) ? tsxParser : jsParser;
        return parse(content, opts);
    } catch {
        return null;
    }
}

/** Walk top-level statements to collect named exports and component definitions. */
function collectTopLevel(ast: t.File, info: SourceFileInfo): void {
    const isComponentName = (name: string): boolean =>
        /^[A-Z]/.test(name);

    for (const node of ast.program.body) {
        // export const X = ...  / export function X() {}
        if (node.type === "ExportNamedDeclaration" && node.declaration) {
            const d = node.declaration;
            if (d.type === "FunctionDeclaration" && d.id) {
                info.exports.add(d.id.name);
                if (isComponentName(d.id.name)) info.components.add(d.id.name);
            } else if (
                (d.type === "VariableDeclaration") &&
                d.declarations[0]?.id?.type === "Identifier"
            ) {
                const name = d.declarations[0].id.name;
                info.exports.add(name);
                if (isComponentName(name)) info.components.add(name);
            }
        }
        // export default function/const Component
        if (node.type === "ExportDefaultDeclaration" && node.declaration) {
            const d = node.declaration;
            if (d.type === "FunctionDeclaration" && d.id) {
                info.components.add(d.id.name);
            } else if (
                d.type === "Identifier" && typeof d.name === "string"
            ) {
                // export default Foo -> treat as exported component
                info.components.add(d.name);
            }
        }
        // hoisted function component definitions (function App() {})
        if (
            node.type === "FunctionDeclaration" &&
            node.id &&
            isComponentName(node.id.name)
        ) {
            info.components.add(node.id.name);
        }
    }
}

function analyzeAst(ast: t.File, file: string, info: SourceFileInfo): void {
    collectTopLevel(ast, info);

    const hookNames = new Set<string>();
    const jsxElements = new Map<string, Set<string>>();

    const visitor = {
        ImportDeclaration: (p: NodePath<t.ImportDeclaration>) => {
            const src = p.node.source.value;
            const set = new Set<string>();
            for (const spec of p.node.specifiers) {
                if (
                    spec.type === "ImportSpecifier" ||
                    spec.type === "ImportDefaultSpecifier" ||
                    spec.type === "ImportNamespaceSpecifier"
                ) {
                    const local = spec.local?.name;
                    if (local) set.add(local);
                }
            }
            info.imports.set(src, set);
        },
        VariableDeclarator: (p: NodePath<t.VariableDeclarator>) => {
            if (p.node.id.type === "Identifier") {
                const name = p.node.id.name;
                const init = p.node.init;
                if (
                    init &&
                    (init.type === "ArrowFunctionExpression" ||
                        init.type === "FunctionExpression")
                ) {
                    if (/^[A-Z]/.test(name)) {
                        info.components.add(name);
                    }
                }
            }
        },
        CallExpression: (p: NodePath<t.CallExpression>) => {
            const callee = p.node.callee;
            if (callee.type === "Identifier" && /^use[A-Z]/.test(callee.name)) {
                hookNames.add(callee.name);
            }
        },
        JSXElement: (p: NodePath<t.JSXElement>) => {
            const tag = p.node.openingElement.name;
            let name: string | null = null;
            if (tag.type === "JSXIdentifier") name = tag.name;
            else if (
                tag.type === "JSXMemberExpression" &&
                tag.property.type === "JSXIdentifier"
            ) {
                name = tag.property.name;
            }
            if (!name) return;
            const attrs = new Set<string>();
            for (const a of p.node.openingElement.attributes) {
                if (a.type === "JSXAttribute" && a.name.type === "JSXIdentifier") {
                    attrs.add(a.name.name);
                }
            }
            const existing = jsxElements.get(name);
            if (existing) {
                for (const a of attrs) existing.add(a);
            } else {
                jsxElements.set(name, attrs);
            }
        },
    };

    traverse(ast, visitor as any);

    info.hooks = hookNames;
    const elementMap = new Map<string, string[]>();
    for (const [name, attrs] of jsxElements) {
        elementMap.set(name, [...attrs]);
    }
    info.jsxElements = elementMap;
}

export async function analyzeProject(projectDir: string): Promise<AstIndex> {
    const index: AstIndex = new Map();
    const srcDir = path.join(projectDir, "src");
    if (!fs.existsSync(srcDir)) return index;

    const walk = async (dir: string): Promise<void> => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                await walk(full);
            } else if (/\.(tsx?|jsx?)$/.test(e.name)) {
                const content = await fs.promises.readFile(full, "utf8");
                const rel = path.relative(projectDir, full);
                const info: SourceFileInfo = {
                    file: rel,
                    imports: new Map(),
                    jsxElements: new Map(),
                    hooks: new Set(),
                    components: new Set(),
                    exports: new Set(),
                };
                const ast = parseOrNull(content, e.name);
                if (ast) analyzeAst(ast, e.name, info);
                index.set(rel, info);
            }
        }
    };

    await walk(srcDir);
    return index;
}

/**
 * Evaluate a single `ast:`-prefixed assertion against the project index.
 * Returns {passed, detail}.
 */
export function matchAstCheck(
    index: AstIndex | undefined,
    check: string,
): { passed: boolean; detail: string } {
    if (!index || index.size === 0) {
        return { passed: false, detail: "no analyzable source" };
    }

    const parts = check.split(":");
    // strip the leading empty from "ast:..." -> ["ast", "import", ...]
    const kind = parts[1];
    const rest = parts.slice(2);

    switch (kind) {
        case "import": {
            const mod = rest[0];
            const named = rest[1];
            if (!mod) return { passed: false, detail: "missing import module" };
            const files: string[] = [];
            for (const f of index.values()) {
                for (const [src, names] of f.imports) {
                    if (src.includes(mod)) {
                        if (named === undefined || names.has(named)) {
                            files.push(f.file);
                        }
                    }
                }
            }
            if (files.length > 0) {
                return {
                    passed: true,
                    detail: `import '${mod}'${
                        named ? ` (${named})` : ""
                    } in ${files.join(", ")}`,
                };
            }
            return {
                passed: false,
                detail: `no import matching '${mod}'${
                    named ? ` with name '${named}'` : ""
                }`,
            };
        }
        case "jsx": {
            const el = rest[0];
            if (!el) return { passed: false, detail: "missing jsx element" };
            const attr = rest[1] === "attr" ? rest[2] : undefined;
            const files: string[] = [];
            for (const f of index.values()) {
                for (const [name, attrs] of f.jsxElements) {
                    if (name === el && (attr === undefined || attrs.includes(attr))) {
                        files.push(f.file);
                    }
                }
            }
            if (files.length > 0) {
                return {
                    passed: true,
                    detail: `<${el}${attr ? ` ${attr}=...` : ""}> in ${files.join(", ")}`,
                };
            }
            return {
                passed: false,
                detail: `<${el}${attr ? ` ${attr}=...` : ""}> not found`,
            };
        }
        case "hook": {
            const raw = rest[0];
            if (!raw) return { passed: false, detail: "missing hook name" };
            const target = raw.startsWith("use") ? raw : `use${raw}`;
            const files: string[] = [];
            for (const f of index.values()) {
                if (f.hooks.has(target)) files.push(f.file);
            }
            if (files.length > 0) {
                return {
                    passed: true,
                    detail: `hook ${target}() in ${files.join(", ")}`,
                };
            }
            return { passed: false, detail: `hook ${target}() not found` };
        }
        case "component": {
            const name = rest[0];
            if (!name) return { passed: false, detail: "missing component name" };
            const files = Array.from(index.values()).filter((f) =>
                f.components.has(name),
            );
            if (files.length > 0) {
                return {
                    passed: true,
                    detail: `component ${name} in ${files.map((f) => f.file).join(", ")}`,
                };
            }
            return { passed: false, detail: `component ${name} not defined` };
        }
        case "exports": {
            const name = rest[0];
            if (!name) return { passed: false, detail: "missing export name" };
            const files = Array.from(index.values()).filter((f) =>
                f.exports.has(name),
            );
            if (files.length > 0) {
                return {
                    passed: true,
                    detail: `export ${name} in ${files.map((f) => f.file).join(", ")}`,
                };
            }
            return { passed: false, detail: `export ${name} not found` };
        }
        default:
            return { passed: false, detail: `unknown ast:${kind} check` };
    }
}
