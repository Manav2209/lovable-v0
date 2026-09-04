import { describe, expect, test } from "bun:test";
import { computeScore, DEFAULT_WEIGHTS, type CaseEvalInput } from "./score";
import type { EvalCase } from "./dataset";
import type { EvaluatedCase } from "./report";
import type { AgentRunStatus } from "./agentRun";

function caseBase(overrides: Partial<EvalCase> = {}): EvalCase {
    return {
        id: "counter-basic",
        prompt: "counter",
        tier: "easy",
        expectedFeatures: [],
        excludedFeatures: [],
        maxDurationMs: 600_000,
        maxFixAttempts: 3,
        ...overrides,
    } as unknown as EvalCase;
}

function evalInput(overrides: Partial<EvaluatedCase> = {}): CaseEvalInput {
    const e = { ...baseEvaluated(), ...overrides };
    return { case: caseBase(), evaluated: e };
}

function baseEvaluated(): EvaluatedCase {
    return {
        result: {
            runId: "r",
            caseId: "counter-basic",
            projectId: "p",
            status: "completed",
            completed: true,
            build: { status: "passed" },
            repair: { attempts: 0, maxAttempts: 3 },
            dependenciesAdded: 0,
            durationMs: 180_000,
            eventsCaptured: 10,
            timestamp: 0,
            maxFixAttempts: 3,
        },
        metrics: {
            buildStatus: "passed",
            fixAttempts: 0,
            durationMs: 180_000,
            filesCreated: 1,
            filesModified: 0,
            dependenciesAdded: 0,
            completed: true,
        },
        checks: { score: 3, total: 3, passed: true, features: [] },
    };
}

describe("DEFAULT_WEIGHTS", () => {
    test("weights sum to 1.0", () => {
        const { tierBonus, ...w } = DEFAULT_WEIGHTS;
        const s = (w.build + w.features + w.fixEfficiency + w.duration + w.quality);
        expect(s).toBeCloseTo(1.0, 5);
    });

    test("quality has 0.20 weight (20 points at max raw)", () => {
        expect(DEFAULT_WEIGHTS.quality).toBe(0.2);
    });
});

describe("computeScore quality dimension", () => {
    test("valid judge drives quality points", () => {
        const input = evalInput({
            judge: {
                fulfilled: 1, coherence: 1, codeQuality: 1, reusability: 1,
                notes: "good", valid: true,
            },
        });
        const s = computeScore(input);
        const q = s.breakdown.find((d) => d.label === "Quality")!;
        expect(q.raw).toBe(100);
        expect(q.points).toBeCloseTo(20, 5);
    });

    test("no judge is neutral 50 (not punitive)", () => {
        const s = computeScore(evalInput());
        const q = s.breakdown.find((d) => d.label === "Quality")!;
        expect(q.raw).toBe(50);
        expect(q.points).toBeCloseTo(10, 5);
    });

    test("failed judge stays neutral but is labelled", () => {
        const s = computeScore(
            evalInput({ judge: { fulfilled: 0, coherence: 0, codeQuality: 0, reusability: 0, notes: "boom", valid: false } }),
        );
        const q = s.breakdown.find((d) => d.label === "Quality")!;
        expect(q.raw).toBe(50);
        expect(q.note).toContain("boom");
    });

    test("perfect case scores 100 total (easy tier, no bonus)", () => {
        const input = evalInput({
            judge: { fulfilled: 1, coherence: 1, codeQuality: 1, reusability: 1, notes: "", valid: true },
        });
        // also make it instant so the Duration dimension maxes out too
        input.evaluated = {
            ...input.evaluated,
            metrics: { ...input.evaluated.metrics, durationMs: 0 },
            result: { ...input.evaluated.result, durationMs: 0 },
        };
        expect(computeScore(input).score).toBeCloseTo(100, 5);
    });
});

describe("computeScore build/feature/fix effects", () => {
    test("workflow_error scores poorly on build", () => {
        const input = evalInput({
            result: {
                ...baseEvaluated().result,
                status: "agent_error" as AgentRunStatus,
                error: "boom",
                repair: { attempts: 3, maxAttempts: 3 },
                maxFixAttempts: 3,
                completed: false,
            },
            metrics: { ...baseEvaluated().metrics, fixAttempts: 3, completed: false },
            checks: undefined,
        });
        const s = computeScore(input);
        const b = s.breakdown.find((d) => d.label === "Build")!;
        expect(b.raw).toBe(10);
    });

    test("more fix attempts lowers fix efficiency", () => {
        const input = evalInput();
        input.evaluated = {
            ...baseEvaluated(),
            metrics: { ...baseEvaluated().metrics, fixAttempts: 3 },
            result: { ...baseEvaluated().result, repair: { attempts: 3, maxAttempts: 3 } },
        };
        const fix = computeScore(input).breakdown.find((d) => d.label === "FixEfficiency")!;
        // 3/3 attempts -> 100 - 60 = 40
        expect(fix.raw).toBe(40);
    });
});
