import fs from "fs";
import path from "path";
import { bootstrapEnv } from "./env";
import { selectCases, type EvalTier } from "./dataset";
import { printSummary, writeReport, type EvalReport, type EvaluatedCase } from "./report";

interface CliArgs {
    filter?: string;
    tier?: EvalTier;
    list: boolean;
    timeoutMs: number;
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = { list: false, timeoutMs: 12 * 60_000 };

    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        switch (arg) {
            case "--filter":
                args.filter = argv[++i];
                break;
            case "--tier":
                args.tier = argv[++i] as EvalTier;
                break;
            case "--list":
                args.list = true;
                break;
            case "--timeout-ms":
                args.timeoutMs = Number(argv[++i]);
                break;
            default:
                console.error(`Unknown argument: ${arg}`);
                process.exit(2);
        }
    }
    return args;
}

async function main() {
    bootstrapEnv();

    // Must be set before any control-module evaluation composes sinks.
    process.env.EVAL_MODE = "1";

    const args = parseArgs(process.argv.slice(2));
    const cases = selectCases({ filter: args.filter, tier: args.tier });

    if (args.list) {
        for (const c of cases) {
            console.log(`${c.id.padEnd(24)} ${c.tier.padEnd(8)} "${c.prompt.slice(0, 60)}..."`);
        }
        console.log(`\n${cases.length} case(s)`);
        return;
    }

    if (cases.length === 0) {
        console.error("No eval cases matched the given --filter/--tier.");
        process.exit(2);
    }

    if (!process.env.GROQ_API_KEY && !process.env.GOOGLE_API_KEY) {
        console.error(
            "No LLM API key set. Add GROQ_API_KEY or GOOGLE_API_KEY to apps/control/.env.",
        );
        process.exit(1);
    }

    const runId = `run_${Date.now().toString(36)}`;
    const runDir = path.resolve(import.meta.dir, "..", "runs", runId);
    await fs.promises.mkdir(path.join(runDir, "results"), { recursive: true });

    process.env.EVAL_EVENT_LOG ??= path.join(runDir, "events.jsonl");

    const provider = process.env.LLM_PROVIDER === "google" ? "google" : "groq";
    const modelName =
        provider === "google"
            ? process.env.GOOGLE_MODEL || "gemini-2.5-flash"
            : process.env.GROQ_MODEL || "llama-3.3-70b-versatile";

    const manifest = {
        runId,
        startedAt: Date.now(),
        provider,
        model: modelName,
        timeoutMsPerCase: args.timeoutMs,
        bunVersion: Bun.version,
        platform: `${process.platform}-${process.arch}`,
        cases: cases.map((c) => ({ id: c.id, tier: c.tier, prompt: c.prompt })),
    };
    await fs.promises.writeFile(
        path.join(runDir, "manifest.json"),
        JSON.stringify(manifest, null, 2),
        "utf8",
    );

    console.log(`Eval run ${runId}`);
    console.log(`  model:     ${provider}/${modelName}`);
    console.log(`  cases:     ${cases.map((c) => c.id).join(", ")}`);
    console.log(`  event log: ${process.env.EVAL_EVENT_LOG}\n`);

    const { runCase } = await import("./offline/runner");

    const evaluated: EvaluatedCase[] = [];
    for (const c of cases) {
        process.stdout.write(`▶ ${c.id} ... `);
        const { result, metrics, checks } = await runCase(c, {
            runId,
            runDir,
            timeoutMs: Math.min(args.timeoutMs, c.maxDurationMs ?? args.timeoutMs),
        });
        evaluated.push({ result, metrics, checks });

        const icon = result.status === "passed_build" ? "✔" : "✘";
        const checkStr = checks
            ? ` [${checks.score}/${checks.total}]`
            : "";
        console.log(
            `${icon} ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s${checkStr}` +
                (result.error ? ` — ${result.error.slice(0, 100)}` : ""),
        );
    }

    const report: EvalReport = {
        runId,
        model: modelName,
        provider,
        startedAt: manifest.startedAt,
        cases: evaluated,
    };

    printSummary(report);
    await writeReport(runDir, report);
    console.log(`Results: ${path.join(runDir, "results")}`);
    console.log(`Report:  ${path.join(runDir, "report.md")}`);

    const passed = evaluated.filter((c) => c.result.status === "passed_build").length;
    if (passed < evaluated.length) process.exitCode = 1;
}

main().catch((err) => {
    console.error("Fatal error in eval CLI:", err);
    process.exit(1);
});
