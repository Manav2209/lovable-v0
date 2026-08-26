export type EvalTier = "easy" | "medium" | "hard";

export interface EvalCase {
    id: string;
    tier: EvalTier;
    prompt: string;
    /**
     * Objective post-build assertions (M4): substrings / file paths /
     * route patterns expected in the generated workspace.
     */
    expectedFeatures: string[];
    /** Budget overrides; falls back to runner defaults when omitted. */
    maxDurationMs?: number;
    maxFixAttempts?: number;
}

export const EVAL_CASES: EvalCase[] = [
    {
        id: "counter-basic",
        tier: "easy",
        prompt:
            "Create a simple counter app with a number display and two buttons: one to increment and one to decrement the count. The count should start at 0.",
        expectedFeatures: ["counter"],
        maxDurationMs: 7 * 60_000,
        maxFixAttempts: 3,
    },
];

export function selectCases(options: { filter?: string; tier?: EvalTier }): EvalCase[] {
    return EVAL_CASES.filter((c) => {
        if (options.filter && !c.id.includes(options.filter)) return false;
        if (options.tier && c.tier !== options.tier) return false;
        return true;
    });
}
