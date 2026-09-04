import { describe, expect, test } from "bun:test";
import {
    evaluateGate,
    renderGate,
    toGateCases,
    type GateScoredCase,
    type GateThresholds,
} from "./gate";

const scores: GateScoredCase[] = [
    { caseId: "counter-basic", overall: 97, tier: "easy" },
    { caseId: "todo-basic", overall: 97, tier: "easy" },
    { caseId: "kanban-board", overall: 100, tier: "hard" },
];

describe("evaluateGate", () => {
    test("passes when all floors and average are met", () => {
        const t: GateThresholds = {
            average: 90,
            cases: { "counter-basic": 90, "todo-basic": 90, "kanban-board": 90 },
        };
        const r = evaluateGate(scores, t);
        expect(r.passed).toBe(true);
        expect(r.breaches).toHaveLength(0);
    });

    test("reports a per-case breach", () => {
        const t: GateThresholds = { cases: { "counter-basic": 98 } };
        const r = evaluateGate(scores, t);
        expect(r.passed).toBe(false);
        expect(r.breaches).toEqual([
            { caseId: "counter-basic", kind: "case", actual: 97, floor: 98, tier: "easy" },
        ]);
    });

    test("reports an average breach", () => {
        const t: GateThresholds = { average: 99 };
        const r = evaluateGate(scores, t); // avg = (97+97+100)/3 = 98
        expect(r.passed).toBe(false);
        expect(r.breaches[0]).toMatchObject({ kind: "average", actual: 98, floor: 99 });
    });

    test("ignores cases without a configured floor", () => {
        const t: GateThresholds = { cases: { "not-in-run": 99 } };
        expect(evaluateGate(scores, t).passed).toBe(true);
    });

    test("empty thresholds is a no-op gate", () => {
        expect(evaluateGate(scores, {}).passed).toBe(true);
    });

    test("empty run fails the gate", () => {
        expect(evaluateGate([], { average: 80 }).passed).toBe(false);
        expect(evaluateGate([], { average: 80 }).breaches[0]?.kind).toBe("empty_run");
    });

    test("incomplete run when fewer cases than expected", () => {
        const r = evaluateGate(scores, {}, { expectedCases: 5 });
        expect(r.passed).toBe(false);
        expect(r.breaches[0]?.kind).toBe("incomplete_run");
    });
});

describe("toGateCases", () => {
    test("maps scored cases to gate cases with tier", () => {
        const scored = [{ caseId: "counter-basic", overall: 97 }] as never;
        const tierOf = { "counter-basic": "easy" };
        const g = toGateCases(scored, tierOf);
        expect(g[0]).toMatchObject({ caseId: "counter-basic", overall: 97, tier: "easy" });
    });
});

describe("renderGate", () => {
    test("renders a pass banner", () => {
        const lines = renderGate({ passed: true, breaches: [] }, scores);
        expect(lines.join("\n")).toContain("PASS");
    });

    test("renders breach details on fail", () => {
        const t: GateThresholds = { cases: { "counter-basic": 98 } };
        const lines = renderGate(evaluateGate(scores, t), scores);
        expect(lines.join("\n")).toContain("counter-basic: 97/100 < floor 98/100");
    });
});
