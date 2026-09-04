import fs from "fs";
import path from "path";
import type { EvalTier, EvalCase } from "./dataset";
import type { EvaluatedCase } from "./report";
import { normalizeRunStatus } from "./agentRun";

export interface ScoreWeights {
    /** Build success + completeness (0-1). */
    build: number;
    /** Feature coverage from checks (0-1). */
    features: number;
    /** Fewer fix attempts relative to budget = better (0-1). */
    fixEfficiency: number;
    /** Faster relative to budget = better (0-1). */
    duration: number;
    /** LLM-as-judge rubric quality (0-1). */
    quality: number;
    /** Tier difficulty bonus applied post-sum. */
    tierBonus: Record<EvalTier, number>;
}

export interface ScoreDimension {
    label: string;
    raw: number;
    max: number;
    weight: number;
    points: number;
    note?: string;
}

export interface CaseScore {
    score: number;
    max: number;
    overall: number;
    /** Build + features + (valid judge quality). Scaled 0-100. */
    productScore: number;
    /** Duration + fix efficiency. Scaled 0-100. Not used as a gate penalty for extra ReAct tool calls. */
    efficiencyScore: number;
    breakdown: ScoreDimension[];
}

/** A case score paired with its case id for reporting. */
export interface ScoredCase extends CaseScore {
    caseId: string;
}

export interface CaseEvalInput {
    case: EvalCase;
    evaluated: EvaluatedCase;
}

export const DEFAULT_WEIGHTS: ScoreWeights = {
    build: 0.35,
    features: 0.25,
    fixEfficiency: 0.1,
    duration: 0.1,
    quality: 0.2,
    tierBonus: { easy: 1.0, medium: 1.1, hard: 1.25 },
};

/**
 * Computes a normalized 0-100 composite score for a single evaluated case.
 *
 * Each dimension is scored 0-100 then weighted. A tier bonus multiplier is
 * applied to the weighted sum so a hard case completed well scores higher than
 * an easy case completed well. The multiplier is best-effort; score is capped
 * at 100.
 */
export function computeScore(
    input: CaseEvalInput,
    weights: ScoreWeights = DEFAULT_WEIGHTS,
): CaseScore {
    const { case: evalCase, evaluated } = input;
    const { result, metrics, checks } = evaluated;

    const maxDuration = evalCase.maxDurationMs ?? 12 * 60_000;
    const maxFixes = evalCase.maxFixAttempts ?? result.maxFixAttempts ?? 3;

    const dims: ScoreDimension[] = [];

    // Build success (0-100).
    let buildRaw: number;
    let buildNote: string | undefined;
    const status = normalizeRunStatus(String(result.status));
    if (status === "completed") {
        buildRaw = 100;
        buildNote = result.build?.status ?? "passed";
    } else if (status === "build_failed") {
        buildRaw = 40;
        buildNote = "failed build";
    } else if (status === "agent_error") {
        buildRaw = 10;
        buildNote = result.error ?? "agent error";
    } else {
        buildRaw = 0;
        buildNote = result.status;
    }
    dims.push({ label: "Build", raw: buildRaw, max: 100, weight: weights.build, points: 0, note: buildNote });

    // Feature coverage (0-100).
    const featRaw = checks ? (checks.score / Math.max(checks.total, 1)) * 100 : 0;
    dims.push({
        label: "Features",
        raw: featRaw,
        max: 100,
        weight: weights.features,
        points: 0,
        note: checks ? `${checks.score}/${checks.total}` : "no checks run",
    });

    // LLM-as-judge quality (0-100). Only meaningful when a valid judge ran;
    // otherwise neutral (50) so it neither helps nor unfairly penalizes.
    const judge = evaluated.judge;
    const qualityRaw = judge
        ? Math.round(
              ((judge.fulfilled + judge.coherence + judge.codeQuality + judge.reusability) /
                  4) *
                  100,
          )
        : 50;
    const qualityNote = judge
        ? judge.valid
            ? `${qualityRaw}/100`
            : `judge failed: ${judge.notes}`
        : "no judge ran";
    dims.push({
        label: "Quality",
        raw: judge?.valid ? qualityRaw : 50,
        max: 100,
        weight: weights.quality,
        points: 0,
        note: qualityNote,
    });

    // Fix efficiency (0-100): normalize fix attempts against budget.
    const attempts = metrics.fixAttempts ?? 0;
    const fixRaw = (() => {
        if (attempts <= 0) return 100; // no fixes needed
        if (maxFixes <= 0) return 100;
        return Math.max(0, 100 - Math.round((attempts / maxFixes) * 60));
    })();
    dims.push({
        label: "FixEfficiency",
        raw: fixRaw,
        max: 100,
        weight: weights.fixEfficiency,
        points: 0,
        note: `${attempts}${maxFixes > 0 ? `/${maxFixes}` : ""} attempts`,
    });

    // Duration efficiency (0-100): normalize against per-case budget.
    const durRaw = (() => {
        if (maxDuration <= 0) return 100;
        const ratio = result.durationMs / maxDuration;
        if (ratio >= 1) return Math.max(0, 100 - Math.round((ratio - 1) * 100));
        return Math.round((1 - ratio) * 100);
    })();
    dims.push({
        label: "Duration",
        raw: durRaw,
        max: 100,
        weight: weights.duration,
        points: 0,
        note: `${(result.durationMs / 1000).toFixed(0)}s/${(maxDuration / 1000).toFixed(0)}s`,
    });

    // Apply weights → 0-100 weighted sum, then tier bonus.
    const rawTotal = dims.reduce((sum, d) => sum + d.raw * d.weight, 0);
    for (const d of dims) d.points = Math.round(d.raw * d.weight);

    const bonus = weights.tierBonus[evalCase.tier] ?? 1;
    const overall = Math.min(100, Math.round(rawTotal * bonus));
    const score = Math.round(rawTotal);

    const judgeValid = Boolean(judge?.valid);
    const productDenom = judgeValid
        ? weights.build + weights.features + weights.quality
        : weights.build + weights.features;
    const productRaw =
        (dims.find((d) => d.label === "Build")?.raw ?? 0) * weights.build +
        (dims.find((d) => d.label === "Features")?.raw ?? 0) * weights.features +
        (judgeValid ? (dims.find((d) => d.label === "Quality")?.raw ?? 0) * weights.quality : 0);
    const productScore = productDenom > 0 ? Math.round((productRaw / productDenom) * 100) : 0;

    const effDenom = weights.fixEfficiency + weights.duration;
    const effRaw =
        (dims.find((d) => d.label === "FixEfficiency")?.raw ?? 0) * weights.fixEfficiency +
        (dims.find((d) => d.label === "Duration")?.raw ?? 0) * weights.duration;
    const efficiencyScore = effDenom > 0 ? Math.round((effRaw / effDenom) * 100) : 0;

    return { score, max: 100, overall, productScore, efficiencyScore, breakdown: dims };
}

/** Computes scores for a set of evaluated cases, keyed by case id. */
export function computeScores(
    cases: EvalCase[],
    evaluated: EvaluatedCase[],
): Map<string, CaseScore> {
    const map = new Map<string, CaseScore>();
    const caseById = new Map(cases.map((c) => [c.id, c] as const));
    for (const ev of evaluated) {
        const evalCase = caseById.get(ev.result.caseId);
        if (!evalCase) continue;
        map.set(evalCase.id, computeScore({ case: evalCase, evaluated: ev }));
    }
    return map;
}

/** Computes ScoredCase[] for display, preserving per-case metadata. */
export function computeScoredCases(
    cases: EvalCase[],
    evaluated: EvaluatedCase[],
): ScoredCase[] {
    const caseById = new Map(cases.map((c) => [c.id, c] as const));
    const out: ScoredCase[] = [];
    for (const ev of evaluated) {
        const evalCase = caseById.get(ev.result.caseId);
        if (!evalCase) continue;
        const s = computeScore({ case: evalCase, evaluated: ev });
        out.push({ ...s, caseId: ev.result.caseId });
    }
    return out;
}

/** Renders the per-case score table for console output. */
export function renderScoreTable(scores: ScoredCase[]): string[] {
    const lines: string[] = [];
    lines.push("");
    lines.push(`Scoreboard (0-100, tier-bonused)`);
    lines.push(`─`.repeat(52));
    scores.sort((a, b) => b.overall - a.overall);
    for (const s of scores) {
        lines.push(
            `  ${s.caseId.padEnd(22)} ${String(s.overall).padStart(3)} (base ${String(s.score).padStart(3)})` +
                `  product:${String(s.productScore).padStart(3)} eff:${String(s.efficiencyScore).padStart(3)}` +
                `  b:${s.breakdown[0]?.raw ?? 0} f:${s.breakdown[1]?.raw ?? 0}` +
                ` q:${s.breakdown[2]?.raw ?? 0}`,
        );
    }
    if (scores.length > 0) {
        const avg = Math.round(
            scores.reduce((a, s) => a + s.overall, 0) / scores.length,
        );
        lines.push(`\n  Average: ${avg}/100`);
    }
    lines.push(`─`.repeat(52));
    return lines;
}

/** Writes a scoreboard to score.md with full per-dimension breakdowns. */
export async function writeScoreBoard(
    runDir: string,
    runId: string,
    scores: ScoredCase[],
): Promise<void> {
    const lines: string[] = [];
    const sep = "─".repeat(60);
    lines.push(`# Eval Scoreboard`);
    lines.push("");
    lines.push(`- **Run:** \`${runId}\``);
    lines.push(`- **Scale:** 0-100 (tier-bonused)`);
    lines.push("");
    lines.push(sep);
    lines.push("");

    scores.sort((a, b) => b.overall - a.overall);
    for (const s of scores) {
        lines.push(`## ${s.caseId} — ${s.overall}/100`);
        lines.push("");
        lines.push(`**Base:** ${s.score}/100 · **Product:** ${s.productScore}/100 · **Efficiency:** ${s.efficiencyScore}/100`);
        lines.push("");
        lines.push(`| Dimension | Raw | Weight | Points | Note |`);
        lines.push(`|-----------|-----|--------|--------|------|`);
        for (const d of s.breakdown) {
            lines.push(
                `| ${d.label} | ${d.raw}/100 | ${d.weight} | ${d.points} | ${d.note ?? ""} |`,
            );
        }
        lines.push("");
    }

    const avg = scores.length
        ? Math.round(scores.reduce((a, s) => a + s.overall, 0) / scores.length)
        : 0;
    lines.push(sep);
    lines.push("");
    lines.push(`## Summary`);
    lines.push("");
    lines.push(`- **Average score:** ${avg}/100`);
    lines.push("");

    await fs.promises.mkdir(runDir, { recursive: true });
    await fs.promises.writeFile(path.join(runDir, "score.md"), lines.join("\n"), "utf8");
}
