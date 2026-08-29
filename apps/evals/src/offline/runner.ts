import fs from "fs";
import path from "path";
import type { WorkflowState } from "@control/agent/graphs/workflow";
import type { EvalCase } from "../dataset";
import { seedWorkspace } from "./workspace";
import { extractMetrics, runChecks, type CheckResult, type EvalMetrics } from "../checks";
import { traceCase } from "@control/observability/langfuse";
import { judgeCase, type JudgeResult } from "../judge";

export type CaseStatus =
    | "passed_build"
    | "failed_build"
    | "workflow_error"
    | "timeout"
    | "crashed";

export interface CaseResult {
    runId: string;
    caseId: string;
    tier: string;
    projectId: string;
    status: CaseStatus;
    completed: boolean;
    buildStatus?: WorkflowState["buildStatus"];
    fixAttempts?: number;
    maxFixAttempts?: number;
    error?: string;
    durationMs: number;
    eventsCaptured: number;
    timestamp: number;
}

export interface RunCaseResult {
    result: CaseResult;
    metrics: EvalMetrics;
    checks?: CheckResult;
    judge?: JudgeResult;
}

export interface RunCaseOptions {
    runId: string;
    runDir: string;
    timeoutMs: number;
    maxFixAttempts?: number;
}

type CaseResultCore = Omit<
    CaseResult,
    "status" | "completed" | "buildStatus" | "fixAttempts" | "error"
>;

const TIMEOUT_MARKER = Symbol("eval-timeout");

/**
 * After a timeout we abort the workflow, then wait up to this long for the
 * in-flight node to settle so no orphaned tool call reads the next case's
 * SHARED_DIR/PROJECT_ID.
 */
const ABORT_GRACE_MS = 5000;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function runCase(
    evalCase: EvalCase,
    options: RunCaseOptions,
): Promise<RunCaseResult> {
    const startedAt = Date.now();

    let result: CaseResult;
    let metrics: EvalMetrics;
    let checks: CheckResult | undefined;
    let judge: JudgeResult | undefined;

    try {
        const workspace = await seedWorkspace(options.runDir, evalCase.id);
        process.env.SHARED_DIR = workspace.sharedDir;

        const { getMemoryEvents, flushEventSink, resetEventSink } = await import(
            "@control/events/sink"
        );
        const { executeMainFlow } = await import("@control/agent/graphs/main");

        const abortController = new AbortController();

        const state: WorkflowState = {
            projectId: workspace.projectId,
            prompt: evalCase.prompt,
            clientId: workspace.projectId,
            fixAttempts: 0,
            maxFixAttempts: options.maxFixAttempts,
            abortSignal: abortController.signal,
            completed: false,
            messages: [],
            threadId: workspace.projectId,
        };

        const workflowPromise = traceCase(
            {
                runId: options.runId,
                caseId: evalCase.id,
                tier: evalCase.tier,
                prompt: evalCase.prompt,
            },
            async () => executeMainFlow(state),
        ).catch((err: unknown): never => {
            throw err instanceof Error ? err : new Error(String(err));
        });

        const raced = await Promise.race([
            workflowPromise.then((final) => ({ kind: "done" as const, final })),
            new Promise<{ kind: typeof TIMEOUT_MARKER }>((resolve) =>
                setTimeout(() => resolve({ kind: TIMEOUT_MARKER }), options.timeoutMs),
            ),
        ]);

        if (raced.kind === TIMEOUT_MARKER) {
            abortController.abort();
            // Let the orphaned workflow settle before runCase returns, so a
            // still-running tool call cannot read the next case's workspace.
            await Promise.race([
                workflowPromise.then(
                    () => undefined,
                    () => undefined,
                ),
                delay(ABORT_GRACE_MS),
            ]);
            result = {
                ...core(evalCase, options, workspace.projectId, startedAt),
                status: "timeout",
                completed: false,
                error: `Exceeded ${options.timeoutMs}ms budget`,
                eventsCaptured: getMemoryEvents().length,
            };
            metrics = extractMetrics({ completed: false, fixAttempts: 0 } as WorkflowState, Date.now() - startedAt);
        } else {
            const final = raced.final as WorkflowState;
            const buildOk = final.completed === true && !final.error;
            result = {
                ...core(evalCase, options, workspace.projectId, startedAt),
                status: buildOk
                    ? "passed_build"
                    : final.error
                      ? "workflow_error"
                      : "failed_build",
                completed: final.completed ?? false,
                buildStatus: final.buildStatus,
                fixAttempts: final.fixAttempts,
                error: final.error,
                eventsCaptured: getMemoryEvents().length,
            };
            metrics = extractMetrics(final, Date.now() - startedAt);

            if (buildOk) {
                checks = await runChecks(workspace.projectDir, evalCase.expectedFeatures);
                if (checks.passed) {
                    const { model } = await import("@control/agent/client");
                    judge = await judgeCase(evalCase, workspace.projectDir, model);
                    if (judge.valid) {
                        console.log(
                            `      q ${((judge.fulfilled + judge.coherence + judge.codeQuality + judge.reusability) / 4 * 100).toFixed(0)}/100 — ${judge.notes.slice(0, 60)}`,
                        );
                    } else {
                        console.log(`      ! judge failed: ${judge.notes.slice(0, 80)}`);
                    }
                }
            }
        }

        await flushEventSink();
        resetEventSink();
    } catch (err) {
        result = {
            ...core(evalCase, options, "", startedAt),
            status: "crashed",
            completed: false,
            error: err instanceof Error ? err.message : String(err),
            eventsCaptured: 0,
        };
        metrics = extractMetrics({ completed: false, fixAttempts: 0 } as WorkflowState, Date.now() - startedAt);
        try {
            const { flushEventSink, resetEventSink } = await import("@control/events/sink");
            await flushEventSink();
            resetEventSink();
        } catch {
            /* sink unavailable */
        }
    }

    await writeResultAtomically(options.runDir, result);
    return { result, metrics, checks, judge };
}

function core(
    evalCase: EvalCase,
    options: RunCaseOptions,
    projectId: string,
    startedAt: number,
): CaseResultCore {
    return {
        runId: options.runId,
        caseId: evalCase.id,
        tier: evalCase.tier,
        projectId,
        durationMs: Date.now() - startedAt,
        eventsCaptured: 0,
        timestamp: startedAt,
        maxFixAttempts: options.maxFixAttempts,
    };
}

async function writeResultAtomically(runDir: string, result: CaseResult): Promise<void> {
    const resultsDir = path.join(runDir, "results");
    await fs.promises.mkdir(resultsDir, { recursive: true });

    const finalPath = path.join(resultsDir, `${result.caseId}.json`);
    const tmpPath = `${finalPath}.tmp-${process.pid}`;

    await fs.promises.writeFile(tmpPath, JSON.stringify(result, null, 2), "utf8");
    await fs.promises.rename(tmpPath, finalPath);
}
