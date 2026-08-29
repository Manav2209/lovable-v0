import fs from "fs";
import path from "path";
import type { CaseResult } from "./offline/runner";
import type { CheckResult, EvalMetrics } from "./checks";

export interface EvalReport {
    runId: string;
    model: string;
    provider: string;
    startedAt: number;
    cases: EvaluatedCase[];
}

export interface EvaluatedCase {
    result: CaseResult;
    metrics: EvalMetrics;
    checks?: CheckResult;
    judge?: import("./judge").JudgeResult;
}

export function printSummary(report: EvalReport): void {
    const header = `Eval Report — ${report.runId} (${report.provider}/${report.model})`;
    const sep = "─".repeat(header.length);
    console.log(`\n${sep}`);
    console.log(header);
    console.log(sep);

    for (const c of report.cases) {
        const icon = c.result.status === "passed_build" ? "✔" : "✘";
        const checkStr = c.checks
            ? ` [features ${c.checks.score}/${c.checks.total}]`
            : "";
        const dur = `${(c.result.durationMs / 1000).toFixed(1)}s`;
        console.log(
            `  ${icon} ${c.result.caseId.padEnd(22)} ${c.result.status.padEnd(16)} ${dur.padStart(8)}${checkStr}`,
        );
        if (c.checks && c.checks.score < c.checks.total) {
            for (const f of c.checks.features) {
                if (!f.passed) {
                    console.log(`      ✘ ${f.feature} — ${f.detail}`);
                }
            }
        }
        if (c.judge?.valid) {
            console.log(
                `      q ${Math.round(
                    ((c.judge.fulfilled + c.judge.coherence + c.judge.codeQuality + c.judge.reusability) /
                        4) *
                        100,
                )}/100 — ${c.judge.notes.slice(0, 80)}`,
            );
        }
    }

    const passed = report.cases.filter((c) => c.result.status === "passed_build").length;
    const allFeatures = report.cases.reduce(
        (a, c) => a + (c.checks?.total ?? 0),
        0,
    );
    const passedFeatures = report.cases.reduce(
        (a, c) => a + (c.checks?.score ?? 0),
        0,
    );
    console.log(`\n  Cases: ${passed}/${report.cases.length} passed build`);
    if (allFeatures > 0) {
        console.log(`  Features: ${passedFeatures}/${allFeatures} passed`);
    }
    console.log(sep + "\n");
}

export async function writeReport(
    runDir: string,
    report: EvalReport,
): Promise<void> {
    const lines: string[] = [];
    const sep = "─".repeat(60);

    lines.push(`# Eval Report`);
    lines.push("");
    lines.push(`- **Run:** \`${report.runId}\``);
    lines.push(`- **Model:** ${report.provider}/${report.model}`);
    lines.push(`- **Started:** ${new Date(report.startedAt).toISOString()}`);
    lines.push(`- **Cases:** ${report.cases.length}`);
    lines.push("");
    lines.push(sep);
    lines.push("");

    for (const c of report.cases) {
        const icon = c.result.status === "passed_build" ? "✔" : "✘";
        const dur = `${(c.result.durationMs / 1000).toFixed(1)}s`;
        lines.push(`## ${icon} ${c.result.caseId} (${c.result.tier})`);
        lines.push("");
        lines.push(`| Metric | Value |`);
        lines.push(`|--------|-------|`);
        lines.push(`| Status | ${c.result.status} |`);
        lines.push(`| Duration | ${dur} |`);
        lines.push(`| Build | ${c.result.buildStatus ?? "n/a"} |`);
        lines.push(
            `| Fix attempts | ${c.result.fixAttempts ?? 0}${
                c.result.maxFixAttempts != null ? ` / ${c.result.maxFixAttempts}` : ""
            } |`,
        );
        lines.push(`| Files created | ${c.metrics.filesCreated} |`);
        lines.push(`| Files modified | ${c.metrics.filesModified} |`);
        lines.push(`| Dependencies added | ${c.metrics.dependenciesAdded} |`);
        lines.push(`| Events captured | ${c.result.eventsCaptured} |`);
        if (c.result.error) {
            lines.push(`| Error | ${c.result.error.slice(0, 200)} |`);
        }

        if (c.checks) {
            lines.push("");
            lines.push(`### Feature checks (${c.checks.score}/${c.checks.total})`);
            lines.push("");
            lines.push(`| Feature | Passed | Detail |`);
            lines.push(`|---------|--------|--------|`);
            for (const f of c.checks.features) {
                lines.push(`| ${f.feature} | ${f.passed ? "✔" : "✘"} | ${f.detail ?? ""} |`);
            }
        }

        if (c.judge?.valid) {
            const j = c.judge;
            const avg = (
                ((j.fulfilled + j.coherence + j.codeQuality + j.reusability) / 4) *
                100
            ).toFixed(0);
            lines.push("");
            lines.push(`### Judge quality (${avg}/100)`);
            lines.push("");
            lines.push(`| Dimension | Score |`);
            lines.push(`|-----------|-------|`);
            lines.push(`| Fulfilled | ${(j.fulfilled * 100).toFixed(0)}/100 |`);
            lines.push(`| Coherence | ${(j.coherence * 100).toFixed(0)}/100 |`);
            lines.push(`| Code quality | ${(j.codeQuality * 100).toFixed(0)}/100 |`);
            lines.push(`| Reusability | ${(j.reusability * 100).toFixed(0)}/100 |`);
            lines.push(`| Notes | ${j.notes} |`);
        }
        lines.push("");
    }

    const passed = report.cases.filter((c) => c.result.status === "passed_build").length;
    const allFeatures = report.cases.reduce((a, c) => a + (c.checks?.total ?? 0), 0);
    const passedFeatures = report.cases.reduce((a, c) => a + (c.checks?.score ?? 0), 0);
    lines.push(sep);
    lines.push("");
    lines.push(`## Summary`);
    lines.push("");
    lines.push(`- **Cases passed:** ${passed}/${report.cases.length}`);
    if (allFeatures > 0) {
        lines.push(`- **Features passed:** ${passedFeatures}/${allFeatures}`);
    }
    lines.push("");

    await fs.promises.writeFile(path.join(runDir, "report.md"), lines.join("\n"), "utf8");
}
