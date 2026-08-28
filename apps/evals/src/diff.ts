import fs from "fs";
import path from "path";
import type { CaseResult, CaseStatus } from "./offline/runner";

/** A single case result paired with its optional feature scores from the run. */
export interface RunCaseSnapshot {
    result: CaseResult;
    features?: { score: number; total: number };
}

/** Snapshot of one run: manifest metadata + per-case results. */
export interface RunSnapshot {
    runId: string;
    model: string;
    provider: string;
    startedAt: number;
    cases: Map<string, RunCaseSnapshot>;
}

export type Transition =
    | "stable_pass"
    | "stable_fail"
    | "improved"
    | "regressed"
    | "new"
    | "removed";

export interface CaseDiff {
    caseId: string;
    tier: string;
    transition: Transition;
    before?: CaseResult;
    after?: CaseResult;
    /** Improvement in status rank (positive = better after). */
    statusDelta: number;
    durationDeltaMs?: number;
    fixDelta?: number;
    featuresBefore?: { score: number; total: number } | null;
    featuresAfter?: { score: number; total: number } | null;
}

export interface DiffReport {
    before: { runId: string; model: string; provider: string };
    after: { runId: string; model: string; provider: string };
    cases: CaseDiff[];
    summary: {
        improved: number;
        regressed: number;
        stablePass: number;
        stableFail: number;
        newCases: number;
        removedCases: number;
        featureScoreDelta: number;
        featureTotalDelta: number;
    };
}

/** Objective ordering of build outcomes; higher is better. */
const STATUS_RANK: Record<CaseStatus, number> = {
    passed_build: 3,
    failed_build: 2,
    workflow_error: 1,
    timeout: 1,
    crashed: 0,
};

/** Reads manifest.json + results/*.json under runDir into a snapshot. */
export async function loadRun(runDir: string): Promise<RunSnapshot> {
    const manifestPath = path.join(runDir, "manifest.json");
    const resultsDir = path.join(runDir, "results");

    let manifest: { runId?: string; model?: string; provider?: string; startedAt?: number } = {};
    if (fs.existsSync(manifestPath)) {
        manifest = JSON.parse(await fs.promises.readFile(manifestPath, "utf8"));
    }

    const cases = new Map<string, RunCaseSnapshot>();
    if (fs.existsSync(resultsDir)) {
        const files = await fs.promises.readdir(resultsDir);
        for (const f of files.filter((x) => x.endsWith(".json"))) {
            const raw = await fs.promises.readFile(path.join(resultsDir, f), "utf8");
            const result = JSON.parse(raw) as CaseResult;
            cases.set(result.caseId, { result });
        }
    }

    return {
        runId: manifest.runId ?? path.basename(runDir),
        model: manifest.model ?? "unknown",
        provider: manifest.provider ?? "unknown",
        startedAt: manifest.startedAt ?? 0,
        cases,
    };
}

/**
 * Compares two run snapshots case-by-case and classifies each transition.
 * Works on any two runs regardless of model differences.
 */
export function compareRuns(before: RunSnapshot, after: RunSnapshot): DiffReport {
    const allCaseIds = new Set<string>([
        ...before.cases.keys(),
        ...after.cases.keys(),
    ]);

    const cases: CaseDiff[] = [];
    let improved = 0;
    let regressed = 0;
    let stablePass = 0;
    let stableFail = 0;
    let newCases = 0;
    let removedCases = 0;
    let featureScoreDelta = 0;
    let featureTotalDelta = 0;

    for (const caseId of allCaseIds) {
        const b = before.cases.get(caseId);
        const a = after.cases.get(caseId);

        const bRank = b ? STATUS_RANK[b.result.status] ?? 0 : -1;
        const aRank = a ? STATUS_RANK[a.result.status] ?? 0 : -1;
        const statusDelta = a ? aRank : 0 - (b ? bRank : 0);

        let transition: Transition;
        if (!b && a) transition = "new";
        else if (b && !a) transition = "removed";
        else if (b && a) {
            if (aRank > bRank) transition = "improved";
            else if (aRank < bRank) transition = "regressed";
            else
                transition =
                    a.result.status === "passed_build" ? "stable_pass" : "stable_fail";
        } else transition = "removed";

        switch (transition) {
            case "improved": improved++; break;
            case "regressed": regressed++; break;
            case "stable_pass": stablePass++; break;
            case "stable_fail": stableFail++; break;
            case "new": newCases++; break;
            case "removed": removedCases++; break;
        }

        const fB = b?.features;
        const fA = a?.features;
        if (fB && fA) {
            featureScoreDelta += (fA.score ?? 0) - (fB.score ?? 0);
            featureTotalDelta += (fA.total ?? 0) - (fB.total ?? 0);
        }

        cases.push({
            caseId,
            tier: (a?.result.tier ?? b?.result.tier) ?? "",
            transition,
            before: b?.result,
            after: a?.result,
            statusDelta,
            durationDeltaMs:
                b?.result && a?.result
                    ? a.result.durationMs - b.result.durationMs
                    : undefined,
            fixDelta:
                (b?.result.fixAttempts ?? 0) != null && (a?.result.fixAttempts ?? 0) != null
                    ? (a?.result.fixAttempts ?? 0) - (b?.result.fixAttempts ?? 0)
                    : undefined,
            featuresBefore: b?.features ?? null,
            featuresAfter: a?.features ?? null,
        });
    }

    // Deterministic ordering: regressions first, then by caseId.
    const transitionOrder: Record<Transition, number> = {
        regressed: 0,
        improved: 1,
        stable_pass: 2,
        stable_fail: 3,
        new: 4,
        removed: 5,
    };
    cases.sort(
        (x, y) =>
            transitionOrder[x.transition] - transitionOrder[y.transition] ||
            x.caseId.localeCompare(y.caseId),
    );

    return {
        before: { runId: before.runId, model: before.model, provider: before.provider },
        after: { runId: after.runId, model: after.model, provider: after.provider },
        cases,
        summary: {
            improved,
            regressed,
            stablePass,
            stableFail,
            newCases,
            removedCases,
            featureScoreDelta,
            featureTotalDelta,
        },
    };
}

const ICONS: Record<Transition, string> = {
    improved: "▲ improved",
    regressed: "▼ regressed",
    stable_pass: "✔ stable",
    stable_fail: "✘ failed",
    new: "★ new",
    removed: "· removed",
};

function statusStr(c?: CaseResult): string {
    return c ? c.status : "—";
}

export function printDiff(diff: DiffReport): void {
    const header = `Diff — ${diff.before.model} (${diff.before.runId}) → ${diff.after.model} (${diff.after.runId})`;
    const sep = "─".repeat(Math.min(header.length, 80));
    console.log(`\n${sep}`);
    console.log(header);
    console.log(sep);

    for (const c of diff.cases) {
        const from = statusStr(c.before);
        const to = statusStr(c.after);
        console.log(
            `  ${ICONS[c.transition].padEnd(10)} ${c.caseId.padEnd(22)} ${from.padEnd(14)} → ${to.padEnd(14)}` +
                (c.durationDeltaMs != null && c.before && c.after
                    ? `  Δ${Math.round(c.durationDeltaMs / 1000)}s`
                    : ""),
        );
    }

    const s = diff.summary;
    console.log(
        `\n  ${s.improved} improved | ${s.regressed} regressed | ${s.stablePass} stable-pass | ` +
            `${s.stableFail} stable-fail | ${s.newCases} new | ${s.removedCases} removed`,
    );
    if (s.featureTotalDelta !== 0) {
        console.log(
            `  Feature checks: ${s.featureScoreDelta >= 0 ? "+" : ""}${s.featureScoreDelta}/${s.featureTotalDelta}`,
        );
    }
    console.log(sep + "\n");
}

export async function writeDiff(runDir: string, diff: DiffReport): Promise<void> {
    const lines: string[] = [];
    const sep = "─".repeat(60);

    lines.push(`# Eval Diff`);
    lines.push("");
    lines.push(`- **Before:** \`${diff.before.runId}\` — ${diff.before.provider}/${diff.before.model}`);
    lines.push(`- **After:** \`${diff.after.runId}\` — ${diff.after.provider}/${diff.after.model}`);
    lines.push("");
    lines.push(sep);
    lines.push("");

    for (const c of diff.cases) {
        const from = statusStr(c.before);
        const to = statusStr(c.after);
        lines.push(`## ${ICONS[c.transition]} ${c.caseId} (${c.tier})`);
        lines.push("");
        lines.push(`| Metric | Before | After |`);
        lines.push(`|--------|--------|-------|`);
        lines.push(`| Status | ${from} | ${to} |`);
        lines.push(
            `| Duration | ${c.before ? `${(c.before.durationMs / 1000).toFixed(1)}s` : "n/a"} | ${c.after ? `${(c.after.durationMs / 1000).toFixed(1)}s` : "n/a"} |`,
        );
        lines.push(
            `| Fix attempts | ${c.before?.fixAttempts ?? 0} | ${c.after?.fixAttempts ?? 0} |`,
        );
        const featB = c.featuresBefore
            ? `${(c.featuresBefore.score / (c.featuresBefore.total || 1)) * 100}%`
            : "n/a";
        const featA = c.featuresAfter
            ? `${(c.featuresAfter.score / (c.featuresAfter.total || 1)) * 100}%`
            : "n/a";
        lines.push(`| Features | ${featB} | ${featA} |`);
        if (c.after?.error) {
            lines.push(`| After error | ${c.after.error.slice(0, 200)} |`);
        }
        lines.push("");
    }

    const s = diff.summary;
    lines.push(sep);
    lines.push("");
    lines.push(`## Summary`);
    lines.push("");
    lines.push(`- **Improved:** ${s.improved}`);
    lines.push(`- **Regressed:** ${s.regressed}`);
    lines.push(`- **Stable pass:** ${s.stablePass}`);
    lines.push(`- **Stable fail:** ${s.stableFail}`);
    lines.push(`- **New:** ${s.newCases}`);
    lines.push(`- **Removed:** ${s.removedCases}`);
    lines.push("");

    await fs.promises.mkdir(runDir, { recursive: true });
    await fs.promises.writeFile(path.join(runDir, "diff.md"), lines.join("\n"), "utf8");
}
