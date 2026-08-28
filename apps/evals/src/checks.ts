import fs from "fs";
import path from "path";
import type { WorkflowState } from "@control/agent/graphs/workflow";
import { analyzeProject, matchAstCheck, type AstIndex } from "./ast";

export interface FeatureResult {
    feature: string;
    passed: boolean;
    detail?: string;
}

export interface EvalMetrics {
    buildStatus?: string;
    fixAttempts: number;
    durationMs: number;
    filesCreated: number;
    filesModified: number;
    dependenciesAdded: number;
    completed: boolean;
    error?: string;
}

export interface CheckResult {
    score: number;
    total: number;
    passed: boolean;
    features: FeatureResult[];
}

export function extractMetrics(state: WorkflowState, durationMs: number): EvalMetrics {
    const cs = state.changeSummary;
    return {
        buildStatus: state.buildStatus,
        fixAttempts: state.fixAttempts,
        durationMs,
        filesCreated: cs?.filesCreated.length ?? 0,
        filesModified: cs?.filesModified.length ?? 0,
        dependenciesAdded: cs?.dependenciesAdded.length ?? 0,
        completed: state.completed,
        error: state.error,
    };
}

// Post-build assertions:
// - Plain string  -> case-insensitive grep across src/**/*.{tsx,ts,jsx,js}
// - "file:<path>" -> file must exist
// - "dep:<name>"  -> dependency present in package.json
export async function runChecks(
    projectDir: string,
    expectedFeatures: string[],
): Promise<CheckResult> {
    const features: FeatureResult[] = [];

    const hasAstChecks = expectedFeatures.some((f) => f.startsWith("ast:"));
    const astIndex: AstIndex = hasAstChecks
        ? await analyzeProject(projectDir)
        : new Map();

    for (const feat of expectedFeatures) {
        if (feat.startsWith("ast:")) {
            const { passed, detail } = matchAstCheck(astIndex, feat);
            features.push({ feature: feat, passed, detail });
        } else if (feat.startsWith("file:")) {
            const rel = feat.slice(5);
            const exists = fs.existsSync(path.join(projectDir, rel));
            features.push({ feature: feat, passed: exists, detail: exists ? "exists" : "missing" });
        } else if (feat.startsWith("dep:")) {
            const dep = feat.slice(4);
            const pkgPath = path.join(projectDir, "package.json");
            let found = false;
            if (fs.existsSync(pkgPath)) {
                const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
                found = !!(pkg.dependencies?.[dep] || pkg.devDependencies?.[dep]);
            }
            features.push({ feature: feat, passed: found, detail: found ? "in package.json" : "not found" });
        } else {
            const hit = await grepSrc(projectDir, feat);
            features.push({ feature: feat, passed: hit > 0, detail: hit > 0 ? `${hit} match${hit > 1 ? "es" : ""}` : "no match" });
        }
    }

    const score = features.filter((f) => f.passed).length;
    return { score, total: features.length, passed: score === features.length, features };
}

async function grepSrc(projectDir: string, needle: string): Promise<number> {
    const srcDir = path.join(projectDir, "src");
    if (!fs.existsSync(srcDir)) return 0;

    const needleLower = needle.toLowerCase();
    let count = 0;
    const walk = async (dir: string): Promise<void> => {
        const entries = await fs.promises.readdir(dir, { withFileTypes: true });
        for (const e of entries) {
            if (e.isDirectory()) {
                await walk(path.join(dir, e.name));
            } else if (/\.(tsx?|jsx?)$/.test(e.name)) {
                const content = await fs.promises.readFile(path.join(dir, e.name), "utf8");
                if (content.toLowerCase().includes(needleLower)) count++;
            }
        }
    };
    await walk(srcDir);
    return count;
}
