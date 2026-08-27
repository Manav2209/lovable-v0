# Eval System + Observability Foundation

Adds a headless eval harness, event sink, deterministic checks, and structured reporting — enabling reproducible quality measurement of the agent pipeline without the UI.

---

## What changed

### Milestone 1 — Event sink + headless mode (7 commits)

Decoupled agent tool modules (`buildSource`, `prompt`, `push`) from the Redis-bound entry point, enabling headless execution. Introduced a pluggable event sink (memory buffer + JSONL file) gated behind `EVAL_MODE=1`.

- `apps/control/src/events/sink.ts` — `AgentEvent` schema, `MemorySink(500)`, `FileSink(JSONL)`, `MultiSink`, `publishStreamEvent()`
- `apps/control/src/agent/tool/code/buildSource.ts` — removed direct `redis` import, replaced `redis.xAdd` → `publishStreamEvent`
- `apps/control/src/agent/process/prompt.ts` — same decoupling + `publishStreamEvent` swap
- `apps/control/src/agent/tool/r2/push.ts` — same decoupling + fixed broken `@/agent/graphs/workflow` import path
- `apps/control/src/sse/index.ts` — eval-mode gated SSE capture
- `apps/control/src/index.ts` — removed `export let redis`
- `apps/control/scripts/smoke-eval-sink.ts` — proves headless import + event capture + JSONL durability

### Milestone 2 — Offline eval harness

`apps/evals/` package: seeds `apps/template/` into a temp workspace, invokes `executeMainFlow` with a timeout, races results, writes per-case JSON.

- `apps/evals/src/index.ts` — CLI entry (`--filter`, `--tier`, `--list`, `--timeout-ms`, `--sleep-ms`)
- `apps/evals/src/env.ts` — loads `apps/control/.env` → root `.env` → `apps/evals/.env`
- `apps/evals/src/offline/workspace.ts` — seeds template, junctions node_modules from template
- `apps/evals/src/offline/runner.ts` — builds `WorkflowState`, invokes `executeMainFlow`, races timeout, atomic per-case results

### Milestone 3 — 12-case dataset

Three tiers, each with `expectedFeatures[]`, `maxDurationMs`, `maxFixAttempts`:

| Tier | Cases |
|---|---|
| easy | counter-basic, todo-basic, landing-page |
| medium | dashboard-cards, weather-display, multi-page-nav |
| hard | kanban-board, crud-contacts, analytics-charts, blog-crud, product-grid, recipe-finder |

### Milestone 4 — Deterministic checks + metrics

`apps/evals/src/checks.ts`:
- Grep-based feature matching (string → src file regex; `file:<path>` → existence; `dep:<name>` → package.json)
- `extractMetrics()` — pulls buildStatus, fixAttempts, files created/modified, dependencies added from `WorkflowState`

### Milestone 5 — Structured reporting

`apps/evals/src/report.ts`:
- `printSummary()` — console table with per-case status, duration, feature check scores
- `writeReport()` — writes `runs/<runId>/report.md` with full markdown tables + metadata

### Milestone 6 — Structural (AST) checks

`apps/evals/src/ast.ts` + `checks.ts` extension: `ast:`-prefixed assertions using `@babel/parser` + `@babel/traverse`.

- `ast:import:<mod>` / `ast:import:<mod>:<name>` — real module/import presence (not grep)
- `ast:jsx:<Element>` / `ast:jsx:<Element>:attr:<Attr>` — actual JSX elements/attributes in rendered output
- `ast:hook:useState` — genuine hook call expressions
- `ast:component:<Name>` / `ast:exports:<Name>` — component definitions and named exports

Applied to high-value cases (`analytics-charts` → recharts imports + real `<BarChart>`/`<LineChart>`; `multi-page-nav`/`blog-crud` → react-router import + `<Route>` + `useState`). Eliminates grep false positives (e.g. a string literal matching "recharts" without importing or rendering it).

### Milestone 7 — Before/after diff

`apps/evals/src/diff.ts`: `loadRun()`, `compareRuns()` (improved/regressed/stable_pass/stable_fail/new/removed + status ranking), `printDiff()`, `writeDiff()` — via `--before <dir> --after <dir>`.

### Milestone 8 — Weighted scoring

`apps/evals/src/score.ts`: `computeScore()` composites build 40% / features 30% / fix-efficiency 15% / duration 15%, normalized 0–100, tier bonus (medium ×1.1, hard ×1.25); `writeScoreBoard()` → `score.md`.

### Observability — Langfuse integration

First-class LLM/tool observability via the OpenTelemetry-based Langfuse SDK.

- `apps/control/src/observability/instrumentation.ts` — OTel `NodeSDK` + `LangfuseSpanProcessor` bootstrap (no-op when `LANGFUSE_ENABLED=0` or keys missing)
- `apps/control/src/observability/langfuse.ts` — shared `CallbackHandler`, `injectLangfuse()` (attaches to each model in `client.ts`), `traceCase()` per-case trace grouping
- Every eval case emits a trace named `run<runId>:<caseId>` with the run as `sessionId`, grouping all LLM generations (`model.invoke()` at all 6 chokepoints) + 25 tool spans under one queryable trace
- Verified live against Langfuse cloud: trace `runrun_mtbqt3dd:counter-basic` ingested with 4 GENERATION observations (token counts captured); costs shown once the project has pricing configured

```bash
# opt out of cloud ingestion (hermetic evals)
LANGFUSE_ENABLED=0 bun run src/index.ts --filter counter-basic
```

---

## Verified results

**Model**: `google/gemini-2.5-flash` (free tier, 20 RPD)

| Case | Status | Duration | Features |
|---|---|---|---|
| counter-basic | ✔ passed_build | 162.1s | 3/3 |
| todo-basic | ✔ passed_build | 159.6s | 5/5 |
| remaining 10 | workflow_error | 0.3s | — |

Remaining cases failed with Gemini free-tier 429 quota exhaustion (`limit: 20 requests/day`). Infrastructure handles this gracefully — errors are captured in results and reported cleanly.

---

## Key design decisions

- **No new infra**: builds entirely on existing LangChain agent pipeline + `apps/template/` seed
- **`EVAL_MODE=1` gating**: same codebase, same agent, zero Redis dependency for eval runs
- **Workspace isolation**: each case gets its own `SHARED_DIR/<projectId>` directory, `node_modules` junctioned from `apps/template/`
- **Provider-agnostic**: switch between Groq and Google via `.env`; default now `google/gemini-2.5-flash`
- **Pre-warmed node_modules**: template workspace is pre-built so eval cases don't pay install cost

---

## How to run

```bash
# All cases (12)
cd apps/evals && bun run ./src/index.ts

# Filtered
bun run ./src/index.ts --filter counter-basic
bun run ./src/index.ts --tier easy
bun run ./src/index.ts --list

# Rate-limit safe (30s between cases)
bun run ./src/index.ts --sleep-ms 30000

# Timeout override
bun run ./src/index.ts --timeout-ms 300000
```

---

## Next steps

1. **Rate-limit mitigation**: rotate API keys or upgrade to paid Gemini tier for full 12-case runs (Gemini free tier caps at 20 RPD)
2. **Add Langfuse scoring/eval**: attach LLM-as-judge evaluation runs to captured traces in Langfuse
3. **AST composition checks**: detect that one component renders another (reference graph), stricter "real hook" top-level-call validation
4. **Event trace viewer**: consume `runs/<runId>/events.jsonl` in control UI
5. **Baseline regression gate**: wire `score.md` thresholds into CI so a model upgrade cannot silently regress quality
