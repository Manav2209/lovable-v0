import fs from "fs";
import path from "path";
import { bootstrapEnv } from "./env";
import { selectCases, type EvalTier } from "./dataset";

interface CliArgs {
    filter?: string;
    tier?: EvalTier;
    list: boolean;
    timeoutMs: number;
}

function parseArgs(argv: string[]): CliArgs {
    const args: CliArgs = { list: false, timeoutMs: 7 * 60_000 };

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

    if (!process.env.GROQ_API_KEY) {
        console.error(
            "GROQ_API_KEY not set. Add it to apps/control/.env or export it before running evals.",
        );
        process.exit(1);
    }

    const runId = `run_${Date.now().toString(36)}`;
    const runDir = path.resolve(import.meta.dir, "..", "runs", runId);
    await fs.promises.mkdir(path.join(runDir, "results"), { recursive: true });

    // Durable JSONL trace for the whole run (crash-safe by design).
    process.env.EVAL_EVENT_LOG ??= path.join(runDir, "events.jsonl");

    const manifest = {
        runId,
        startedAt: Date.now(),
        model: process.env.GROQ_MODEL || "llama-3.3-70b-versatile",
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
    console.log(`  model:     ${manifest.model}`);
    console.log(`  cases:     ${cases.map((c) => c.id).join(", ")}`);
    console.log(`  event log: ${process.env.EVAL_EVENT_LOG}\n`);

    const { runCase } = await import("./offline/runner");

    const results = [];
    for (const c of cases) {
        process.stdout.write(`▶ ${c.id} ... `);
        const result = await runCase(c, {
            runId,
            runDir,
            timeoutMs: Math.min(args.timeoutMs, c.maxDurationMs ?? args.timeoutMs),
        });
        results.push(result);

        const icon =
            result.status === "passed_build" ? "✔" : "✘";
        console.log(
            `${icon} ${result.status} in ${(result.durationMs / 1000).toFixed(1)}s` +
                (result.error ? ` — ${result.error.slice(0, 120)}` : ""),
        );
    }

    console.log(`\nResults dir: ${path.join(runDir, "results")}`);

    const passed = results.filter((r) => r.status === "passed_build").length;
    if (passed < results.length) process.exitCode = 1;
}

main().catch((err) => {
    console.error("Fatal error in eval CLI:", err);
    process.exit(1);
});
