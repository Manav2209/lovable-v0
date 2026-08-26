import fs from "fs";
import path from "path";
import type { WorkflowState } from "@control/agent/graphs/workflow";
import type { EvalCase } from "../dataset";
import { seedWorkspace } from "./workspace";
import { extractMetrics, runChecks, type CheckResult, type EvalMetrics } from "../checks";

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
    error?: string;
    durationMs: number;
    eventsCaptured: number;
    timestamp: number;
}

export interface RunCaseResult {
    result: CaseResult;
    metrics: EvalMetrics;
    checks?: CheckResult;
}

export interface RunCaseOptions {
    runId: string;
    runDir: string;
    timeoutMs: number;
}

type CaseResultCore = Omit<
    CaseResult,
    "status" | "completed" | "buildStatus" | "fixAttempts" | "error"
>;

const TIMEOUT_MARKER = Symbol("eval-timeout");

export async function runCase(
    evalCase: EvalCase,
    options: RunCaseOptions,
): Promise<RunCaseResult> {
    const startedAt = Date.now();

    let result: CaseResult;
    let metrics: EvalMetrics;
    let checks: CheckResult | undefined;

    try {
        const workspace = await seedWorkspace(options.runDir, evalCase.id);
        process.env.SHARED_DIR = workspace.sharedDir;

        const { getMemoryEvents, flushEventSink } = await import(
            "@control/events/sink"
        );
        const { executeMainFlow } = await import("@control/agent/graphs/main");

        const state: WorkflowState = {
            projectId: workspace.projectId,
            prompt: evalCase.prompt,
            clientId: workspace.projectId,
            fixAttempts: 0,
            completed: false,
            messages: [],
            threadId: workspace.projectId,
        };

        const workflowPromise = executeMainFlow(state).catch(
            (err: unknown): never => {
                throw err instanceof Error ? err : new Error(String(err));
            },
        );

        const raced = await Promise.race([
            workflowPromise.then((final) => ({ kind: "done" as const, final })),
            new Promise<{ kind: typeof TIMEOUT_MARKER }>((resolve) =>
                setTimeout(() => resolve({ kind: TIMEOUT_MARKER }), options.timeoutMs),
            ),
        ]);

        if (raced.kind === TIMEOUT_MARKER) {
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
            }
        }

        await flushEventSink();
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
            const { flushEventSink } = await import("@control/events/sink");
            await flushEventSink();
        } catch {
            /* sink unavailable */
        }
    }

    await writeResultAtomically(options.runDir, result);
    return { result, metrics, checks };
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
