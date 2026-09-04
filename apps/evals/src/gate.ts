import fs from "fs";
import type { ScoredCase } from "./score";

/**
 * Regression-gate thresholds loaded from a JSON file.
 *
 * Format:
 *   {
 *     "average": 80,                       // minimum run average (overall, 0-100)
 *     "cases": { "counter-basic": 89 }     // per-case overall floors (0-100)
 *   }
 */
export interface GateThresholds {
    average?: number;
    cases?: Record<string, number>;
    /** Fail the gate if fewer than this many cases were scored. */
    minCases?: number;
}

/** A single threshold breach detected during evaluation. */
export interface GateBreach {
    /** omitted for the average check */
    caseId?: string;
    kind: "average" | "case" | "empty_run" | "incomplete_run";
    actual: number;
    floor: number;
    tier?: string;
}

export interface GateResult {
    passed: boolean;
    breaches: GateBreach[];
}

/** Scored case plus its tier, for gate reporting. */
export interface GateScoredCase {
    caseId: string;
    overall: number;
    productScore?: number;
    tier?: string;
}

export function toGateCases(scores: ScoredCase[], tiers: Record<string, string>): GateScoredCase[] {
    return scores.map((s) => ({
        caseId: s.caseId,
        overall: s.productScore ?? s.overall,
        productScore: s.productScore,
        tier: tiers[s.caseId],
    }));
}

/** Loads and validates a thresholds JSON file. Blank -> {} (no-op gate). */
export async function loadThresholds(
    file?: string,
): Promise<GateThresholds> {
    if (!file) return {};
    if (!fs.existsSync(file)) {
        throw new Error(`Thresholds file not found: ${file}`);
    }
    const raw = await fs.promises.readFile(file, "utf8");
    return JSON.parse(raw) as GateThresholds;
}

/**
 * Compares scored cases against thresholds.
 * - The run average (of tier-bonused `overall`) must be >= thresholds.average.
 * - Each case's `overall` must be >= its per-case floor.
 * Only evaluated cases with a known score are compared; missing per-case
 * thresholds are ignored.
 */
export function evaluateGate(
    scores: GateScoredCase[],
    thresholds: GateThresholds,
    options?: { expectedCases?: number },
): GateResult {
    const breaches: GateBreach[] = [];

    if (scores.length === 0) {
        return {
            passed: false,
            breaches: [{ kind: "empty_run", actual: 0, floor: options?.expectedCases ?? thresholds.minCases ?? 1 }],
        };
    }

    const expected = options?.expectedCases ?? thresholds.minCases;
    if (expected != null && scores.length < expected) {
        breaches.push({
            kind: "incomplete_run",
            actual: scores.length,
            floor: expected,
        });
    }

    if (thresholds.average !== undefined && scores.length > 0) {
        const avg = Math.round(
            scores.reduce((a, s) => a + s.overall, 0) / scores.length,
        );
        if (avg < thresholds.average) {
            breaches.push({
                kind: "average",
                actual: avg,
                floor: thresholds.average,
            });
        }
    }

    if (thresholds.cases) {
        for (const s of scores) {
            const floor = thresholds.cases[s.caseId];
            if (floor === undefined) continue;
            if (s.overall < floor) {
                breaches.push({
                    caseId: s.caseId,
                    kind: "case",
                    actual: s.overall,
                    floor,
                    tier: s.tier,
                });
            }
        }
    }

    return { passed: breaches.length === 0, breaches };
}

/** Renders the gate result as console lines. */
export function renderGate(
    result: GateResult,
    scores: GateScoredCase[],
): string[] {
    const lines: string[] = [];
    lines.push("");
    lines.push(`Regression gate`);
    lines.push(`─`.repeat(52));
    if (result.passed) {
        lines.push(`  PASS - all thresholds met`);
    } else {
        lines.push(`  FAIL - ${result.breaches.length} threshold(s) breached`);
        for (const b of result.breaches) {
            if (b.kind === "average") {
                lines.push(
                    `    average ${b.actual}/100 < floor ${b.floor}/100`,
                );
            } else if (b.kind === "empty_run") {
                lines.push(`    empty/invalid run: 0 scored cases (need ${b.floor})`);
            } else if (b.kind === "incomplete_run") {
                lines.push(`    incomplete run: ${b.actual} scored cases < ${b.floor} expected`);
            } else {
                lines.push(
                    `    ${b.caseId}: ${b.actual}/100 < floor ${b.floor}/100` +
                        (b.tier ? ` (${b.tier})` : ""),
                );
            }
        }
    }
    if (scores.length > 0) {
        lines.push(`  avg=${Math.round(scores.reduce((a, s) => a + s.overall, 0) / scores.length)}/100`);
    }
    lines.push(`─`.repeat(52));
    return lines;
}
