import fs from "fs";
import path from "path";
import type { EvalCase } from "../dataset";
import { seedWorkspace } from "./workspace";
import { extractMetrics, runChecks, type CheckResult, type EvalMetrics } from "../checks";
import { traceAgentRun } from "@control/observability/langfuse";
import { emptyAgentStats } from "@control/agent/agentStats";
import { judgeCase, type JudgeResult } from "../judge";
import {
    type AgentRunResult,
    type AgentRunStatus,
    type EvaluationDimensions,
} from "../agentRun";
import { diffSnapshots, snapshotWorkspace } from "../workspaceDiff";
import { evaluationDimensions, runBehaviorChecks, type BehaviorCheck } from "../behavior";
import type { WorkflowState } from "@control/agent/graphs/workflow";

export type CaseStatus = AgentRunStatus;
export type CaseResult = AgentRunResult;

export interface RunCaseResult {
    result: AgentRunResult;
    metrics: EvalMetrics;
    checks?: CheckResult;
    judge?: JudgeResult;
    dimensions: EvaluationDimensions;
    behavior: BehaviorCheck[];
}

export interface RunCaseOptions {
    runId: string;
    runDir: string;
    timeoutMs: number;
    maxFixAttempts?: number;
}

const TIMEOUT_MARKER = Symbol("eval-timeout");
const ABORT_GRACE_MS = 5000;

function delay(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

function mapStatus(args: {
    timedOut: boolean;
    crashed?: boolean;
    completed: boolean;
    error?: string;
    buildStatus?: string;
}): AgentRunStatus {
    if (args.timedOut) return "timeout";
    if (args.crashed) return "crashed";
    if (args.completed && !args.error) return "completed";
    if (args.buildStatus === "errors" || args.buildStatus === "pending") return "build_failed";
    if (args.error) return "agent_error";
    return "build_failed";
}

export async function runCase(
    evalCase: EvalCase,
    options: RunCaseOptions,
): Promise<RunCaseResult> {
    const startedAt = Date.now();

    let result: AgentRunResult;
    let metrics: EvalMetrics;
    let checks: CheckResult | undefined;
    let judge: JudgeResult | undefined;
    let behavior: BehaviorCheck[] = [];

    try {
        const workspace = await seedWorkspace(options.runDir, evalCase.id, {
            fixture: evalCase.fixture,
        });
        process.env.SHARED_DIR = workspace.sharedDir;

        const beforeSnap = await snapshotWorkspace(workspace.projectDir);

        const { getMemoryEvents, flushEventSink, resetEventSink } = await import(
            "@control/events/sink"
        );
        const { executeMainFlow } = await import("@control/agent/graphs/main");

        const abortController = new AbortController();

        const workflowPromise = traceAgentRun(
            {
                runId: options.runId,
                caseId: evalCase.id,
                projectId: workspace.projectId,
                prompt: evalCase.prompt,
                tier: evalCase.tier,
                agentMode: "eval",
            },
            async () =>
                executeMainFlow({
                    projectId: workspace.projectId,
                    prompt: evalCase.prompt,
                    clientId: workspace.projectId,
                    fixAttempts: 0,
                    maxFixAttempts: options.maxFixAttempts,
                    abortSignal: abortController.signal,
                    completed: false,
                    messages: [],
                    threadId: workspace.projectId,
                }),
        ).then(({ value, traceId }) => ({
            ...value,
            traceId: traceId ?? value.traceId,
        })).catch((err: unknown): never => {
            throw err instanceof Error ? err : new Error(String(err));
        });

        const raced = await Promise.race([
            workflowPromise.then((final) => ({ kind: "done" as const, final })),
            new Promise<{ kind: typeof TIMEOUT_MARKER }>((resolve) =>
                setTimeout(() => resolve({ kind: TIMEOUT_MARKER }), options.timeoutMs),
            ),
        ]);

        const afterSnap = await snapshotWorkspace(workspace.projectDir);
        const workspaceDiff = diffSnapshots(beforeSnap, afterSnap);

        if (raced.kind === TIMEOUT_MARKER) {
            abortController.abort();
            await Promise.race([
                workflowPromise.then(
                    () => undefined,
                    () => undefined,
                ),
                delay(ABORT_GRACE_MS),
            ]);
            result = baseResult(evalCase, options, workspace.projectId, startedAt, {
                status: "timeout",
                completed: false,
                error: `Exceeded ${options.timeoutMs}ms budget`,
                eventsCaptured: getMemoryEvents().length,
                workspaceDiff,
            });
            metrics = extractMetrics(result);
        } else {
            const final = raced.final as WorkflowState;
            const stats = final.agentStats ?? emptyAgentStats();
            const status = mapStatus({
                timedOut: false,
                completed: final.completed === true && !final.error,
                error: final.error,
                buildStatus: final.buildStatus,
            });
            const cs = final.changeSummary;
            result = baseResult(evalCase, options, workspace.projectId, startedAt, {
                status,
                completed: status === "completed",
                error: final.error,
                eventsCaptured: getMemoryEvents().length,
                workspaceDiff,
                traceId: final.traceId,
                build: {
                    status:
                        final.buildStatus === "success" || final.buildStatus === "tested"
                            ? "passed"
                            : final.buildStatus === "errors"
                              ? "failed"
                              : "not_run",
                    diagnostics: final.buildOutput?.slice(0, 4000),
                },
                repair: {
                    attempts: final.fixAttempts,
                    maxAttempts: options.maxFixAttempts ?? final.maxFixAttempts ?? 0,
                },
                agent: {
                    steps: stats.steps,
                    toolCalls: stats.toolCalls,
                    durationMs: Date.now() - startedAt,
                },
                files: {
                    created: cs?.filesCreated.length ?? workspaceDiff.created.length,
                    modified: cs?.filesModified.length ?? workspaceDiff.modified.length,
                    deleted: cs?.filesDeleted.length ?? workspaceDiff.deleted.length,
                },
                dependenciesAdded: cs?.dependenciesAdded.length ?? 0,
                react: {
                    toolCallsByTool: stats.toolCallsByTool,
                    readOps: stats.readOps,
                    mutationOps: stats.mutationOps,
                    buildCount: stats.buildCount,
                    timeToFirstToolMs: stats.timeToFirstToolMs,
                    stitchInvoked: stats.stitchInvoked,
                },
            });
            metrics = extractMetrics(result);

            if (status === "completed") {
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

        behavior = runBehaviorChecks(result);
        await flushEventSink();
        resetEventSink();
    } catch (err) {
        result = baseResult(evalCase, options, "", startedAt, {
            status: "crashed",
            completed: false,
            error: err instanceof Error ? err.message : String(err),
            eventsCaptured: 0,
        });
        metrics = extractMetrics(result);
        behavior = runBehaviorChecks(result);
        try {
            const { flushEventSink, resetEventSink } = await import("@control/events/sink");
            await flushEventSink();
            resetEventSink();
        } catch {
            /* sink unavailable */
        }
    }

    await writeResultAtomically(options.runDir, result);
    const dimensions = evaluationDimensions(
        result,
        checks?.passed,
        judge?.valid,
        Boolean(checks),
        Boolean(judge),
    );
    return { result, metrics, checks, judge, dimensions, behavior };
}

function baseResult(
    evalCase: EvalCase,
    options: RunCaseOptions,
    projectId: string,
    startedAt: number,
    extra: Partial<AgentRunResult> & Pick<AgentRunResult, "status" | "completed">,
): AgentRunResult {
    return {
        runId: options.runId,
        caseId: evalCase.id,
        projectId,
        tier: evalCase.tier,
        timestamp: startedAt,
        durationMs: Date.now() - startedAt,
        eventsCaptured: extra.eventsCaptured ?? 0,
        maxFixAttempts: options.maxFixAttempts,
        dependenciesAdded: extra.dependenciesAdded ?? 0,
        ...extra,
    };
}

async function writeResultAtomically(runDir: string, result: AgentRunResult): Promise<void> {
    const resultsDir = path.join(runDir, "results");
    await fs.promises.mkdir(resultsDir, { recursive: true });

    const finalPath = path.join(resultsDir, `${result.caseId}.json`);
    const tmpPath = `${finalPath}.tmp-${process.pid}`;

    await fs.promises.writeFile(tmpPath, JSON.stringify(result, null, 2), "utf8");
    await fs.promises.rename(tmpPath, finalPath);
}
