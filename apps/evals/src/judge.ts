import fs from "fs";
import path from "path";
import type { BaseChatModel } from "@langchain/core/language_models/chat_models";
import { HumanMessage, SystemMessage } from "@langchain/core/messages";
import type { EvalCase } from "./dataset";

/**
 * LLM-as-a-judge: a rubric-based quality assessment layered on top of the
 * deterministic checks. Runs ONLY after a case passes the build, so we do not
 * waste judge calls on broken apps.
 *
 * The judge reads the original prompt + a bounded sample of the generated
 * src/ files and returns structured scores (0-1 each) for fulfillment,
 * coherence, code quality, and reusability, plus free-form notes.
 */

export interface JudgeResult {
    /** 0-1 how well the app fulfills the prompt. */
    fulfilled: number;
    /** 0-1 UI/UX coherence and completeness. */
    coherence: number;
    /** 0-1 code organization, correctness, state handling. */
    codeQuality: number;
    /** 0-1 componentization / reusability (not one mega-file). */
    reusability: number;
    notes: string;
    /** true when the judge returned valid structured output. */
    valid: boolean;
}

/** Max total characters of source passed to the judge (≈ budget guard). */
const MAX_SNAPSHOT_CHARS = 24_000;
const MAX_FILES = 20;

/** Hard budget for a single judge call so it can never stall a whole run. */
const JUDGE_TIMEOUT_MS = 30_000;

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
    return new Promise<T>((resolve, reject) => {
        const t = setTimeout(
            () => reject(new Error(`judge timed out after ${ms}ms`)),
            ms,
        );
        p.then(
            (v) => {
                clearTimeout(t);
                resolve(v);
            },
            (e) => {
                clearTimeout(t);
                reject(e);
            },
        );
    });
}

/** A judge that failed to produce structured output (used as a safe default). */
export function failedJudgeResult(reason: string): JudgeResult {
    return {
        fulfilled: 0,
        coherence: 0,
        codeQuality: 0,
        reusability: 0,
        notes: `judge failed: ${reason}`,
        valid: false,
    };
}

/**
 * Builds a bounded text snapshot of the generated project src/ tree: a file
 * list + (truncated) contents, capped to keep judge cost negligible and stay
 * within context.
 */
export async function snapshotProject(projectDir: string): Promise<string> {
    const srcDir = path.join(projectDir, "src");
    const lines: string[] = [];
    let budget = MAX_SNAPSHOT_CHARS;

    const walk = async (dir: string, rel: string): Promise<void> => {
        let entries: fs.Dirent[] = [];
        try {
            entries = await fs.promises.readdir(dir, { withFileTypes: true });
        } catch {
            return;
        }
        for (const e of entries) {
            if (budget <= 0) return;
            const full = path.join(dir, e.name);
            if (e.isDirectory()) {
                await walk(full, path.join(rel, e.name));
            } else if (/\.(tsx?|jsx?)$/.test(e.name)) {
                const relPath = path.join(rel, e.name);
                const content = await fs.promises.readFile(full, "utf8");
                const truncated =
                    content.length > 3000
                        ? content.slice(0, 3000) + "\n... (truncated)"
                        : content;
                const block = `### ${relPath}\n${truncated}\n`;
                lines.push(block);
                budget -= block.length;
                if (lines.length >= MAX_FILES) return;
            }
        }
    };

    await walk(srcDir, "src");
    return lines.join("\n");
}

const RUBRIC = `You are an expert frontend engineer reviewing a React app generated from a short product prompt.

Evaluate the generated app against the prompt and score four dimensions. Be strict and objective — a working build is not enough; the app must genuinely deliver the prompt's intent.

Return ONLY a single JSON object, no markdown, with this exact shape:
{
  "fulfilled": <0 to 1>,
  "coherence": <0 to 1>,
  "codeQuality": <0 to 1>,
  "reusability": <0 to 1>,
  "notes": "<one or two sentences>"
}

Scoring guidance:
- fulfilled: does the app implement the requested features and behavior?
- coherence: is the UI complete, consistent, and usable (no dead ends)?
- codeQuality: correct state handling, no obvious bugs, sensible structure.
- reusability: components broken out rather than one giant file.`;

const EXTRACT_JSON = /(\{[\s\S]*\})/;

function parseJudgeOutput(text: string): Omit<JudgeResult, "valid"> | null {
    const match = text.trim().match(EXTRACT_JSON);
    const raw = match?.[1];
    if (!raw) return null;
    try {
        const parsed = JSON.parse(raw);
        const clamp = (v: unknown): number => {
            const n = typeof v === "number" ? v : NaN;
            if (Number.isNaN(n)) return 0;
            return Math.max(0, Math.min(1, n));
        };
        return {
            fulfilled: clamp(parsed.fulfilled),
            coherence: clamp(parsed.coherence),
            codeQuality: clamp(parsed.codeQuality),
            reusability: clamp(parsed.reusability),
            notes: typeof parsed.notes === "string" ? parsed.notes : "",
        };
    } catch {
        return null;
    }
}

/**
 * Runs the judge against a built project. Returns a valid JudgeResult, or a
 * failedJudgeResult on error / bad model output so callers can degrade safely.
 */
export async function judgeCase(
    evalCase: EvalCase,
    projectDir: string,
    model: BaseChatModel,
): Promise<JudgeResult> {
    let text: string;
    try {
        const snapshot = await snapshotProject(projectDir);
        const res = await withTimeout(
            model.invoke([
                new SystemMessage(RUBRIC),
                new HumanMessage(
                    `PROMPT:\n${evalCase.prompt}\n\nGENERATED APP SOURCE:\n${snapshot}`,
                ),
            ]),
            JUDGE_TIMEOUT_MS,
        );
        text = typeof res.content === "string" ? res.content : JSON.stringify(res.content);
    } catch (err) {
        return failedJudgeResult(err instanceof Error ? err.message : String(err));
    }

    const parsed = parseJudgeOutput(text);
    if (!parsed) return failedJudgeResult("non-JSON judge output");
    return { ...parsed, valid: true };
}
