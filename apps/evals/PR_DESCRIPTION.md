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

1. **Rate-limit mitigation**: rotate API keys or upgrade to paid Gemini tier for full 12-case runs
2. **AST-based checks**: beyond regex/grep — parse imports, component structure, hook usage
3. **Eval difference report**: per-case before/after diff for model upgrades
4. **Event trace viewer**: consume `runs/<runId>/events.jsonl` in control UI (M6)
5. **Scoring rubric**: weighted composite score across build, features, complexity, UI quality
