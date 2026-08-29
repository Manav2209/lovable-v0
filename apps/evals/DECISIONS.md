# Eval System — Decisions & Methodology

A running record of **what** we built for evaluating the agent, **why** we made each call, and **how** it works. Companion to `PR_DESCRIPTION.md` (what changed) and `flow.md`/`decision.md` (product architecture). This file focuses on the *reasoning* behind the eval + observability stack.

---

## 1. Why an eval system at all

The core product is an LLM agent that turns a prompt into a working React app. You cannot trust "it looks okay in one manual run" — the pipeline is stochastic (model choice, temperature, tool trajectory, fix loop), so quality must be measured reproducibly and headlessly.

**Goal:** a deterministic, scriptable harness that runs the real agent against real prompts, checks the *output artifacts* objectively, reports structured results, and can act as a regression gate when models/agents change.

**Non-goals (explicit):**
- Not a unit test of the agent code — it's an integration/behavioral harness on the real `executeMainFlow`.
- Not a UI feature — everything runs headless, `EVAL_MODE=1`, with zero Redis/K8s dependency.

---

## 2. Core architectural decisions

### 2.1 Reuse the real agent, headlessly (not a mock)
**Decision:** Evals invoke the actual `executeMainFlow(state)` (the production LangChain agent), not a stubbed copy.
**Why:** A mock would measure an approximation; we want to measure the real thing. The product already had a `WorkflowState` + `executeMainFlow`, so the harness is thin.

### 2.2 Decouple tools from the Redis entry point (M1)
**Decision:** Removed direct `redis.xAdd` calls from `buildSource`, `prompt`, `push`; replaced with a pluggable event sink (`publishStreamEvent`) gated behind `EVAL_MODE=1`.
**Why:** Eval runs have no Redis. We need the same code path but with events routed to in-memory/JSONL instead of Redis streams. A single switch (`EVAL_MODE=1`) flips the whole system into hermetic mode without forking the agent logic.
**How:** `events/sink.ts` — `MemorySink(500)`, `FileSink(JSONL)`, `MultiSink`, `publishStreamEvent()`. The sink in `client.ts`/agent modules reads the env mode to decide where events go.

### 2.3 Each case gets an isolated workspace (M2)
**Decision:** Each case seeds `apps/template/` into its own `SHARED_DIR/<projectId>`; `node_modules` is junctioned from a pre-warmed template so cases don't pay install cost.
**Why:** Isolation prevents cross-case state leaks and makes a case reproducible; pre-warming `node_modules` was required because a real `bun install` per case is too slow for a 12-case suite.

### 2.4 Env precedence — one source of truth, local overrides (M2)
**Decision:** `bootstrapEnv()` loads in order (lowest → highest priority): `apps/control/.env` → `<repoRoot>/.env` → `apps/evals/.env`. Later files never override already-set `process.env` vars.
**Why:** The eval process must see the *same* agent runtime defaults the product uses, but must be able to override model/provider per suite without editing shared files. Secrets live in gitignored `.env` files (root `.gitignore` ignores `.env`; `apps/evals/.gitignore` ignores `.env` + `runs/`) — never committed.

### 2.5 Provider-agnostic, switched by env (M2 → current)
**Decision:** `client.ts` resolves the model from `LLM_PROVIDER` (`groq` | `google` | `airouter`) and per-provider `*_API_KEY`/`*_MODEL`/`*_BASE_URL`.
**Why:** Model/availability/cost change rapidly; the harness + scoring must not be coupled to a single vendor. Each provider is an *additive* branch — existing paths are untouched.

---

## 3. Dataset & checks — measuring "did it build the right thing"

### 3.1 12-case dataset across three tiers (M3)
**Why tiers:** easy / medium / hard captures the difficulty spectrum so a model can't score well by acing only trivial prompts. Each case has `expectedFeatures[]`, `maxDurationMs`, `maxFixAttempts`.

### 3.2 Deterministic checks, not just "did it compile" (M4)
**Decision:** Post-build assertions that are **deterministic** (no LLM involved, zero cost, fully reproducible):
- plain string → case-insensitive grep across `src/**/*.{tsx,ts,jsx,js}`
- `file:<path>` → file existence
- `dep:<name>` → dependency present in `package.json`

**Why:** Build passing ≠ prompt fulfilled. A hello-world template can "build" but fail every feature. Deterministic checks give an objective, cheap, no-judge-needed layer.
**Caveat acknowledged:** grep has false positives (a string literal matches without real functionality) — this is exactly why we added AST checks (3.3).

### 3.3 AST / structural checks — kill grep false positives (M6)
**Decision:** Add `ast:` assertions using `@babel/parser` + `@babel/traverse`:
- `ast:import:<mod>` / `ast:import:<mod>:<name>` — *real* import presence
- `ast:jsx:<Element>` / `ast:jsx:<Element>:attr:<Attr>` — real rendered JSX element/attribute
- `ast:hook:useState` — genuine hook call
- `ast:component:<Name>` / `ast:exports:<Name>` — component definitions / named exports

**Why:** The greps would wrongly pass when e.g. "recharts" appears only as a string literal without being imported or rendered. Parsing the actual AST proves the element/import/hook exists in code, not just in text.
**How:** `ast.ts` builds per-file `SourceFileInfo` (imports, JSX elements+attrs, hooks, components, exports) into an index via a Babel walk; `checks.ts` dispatches `ast:`-prefixed features to `matchAstCheck()`. Applied to `analytics-charts` (recharts + real `<BarChart>`/`<LineChart>`), `multi-page-nav`/`blog-crud` (react-router + `<Route>` + `useState`).

**Known limitation (documented):** presence ≠ correctness. An element can exist yet be wired wrong — the *composition* relationship (one component rendering another, top-level hook placement) is not yet checked. This is the planned AST-composition extension (not yet implemented).

---

## 4. Scoring — turning results into one number

### 4.1 Composite weighted score (M8)
**Decision:** `computeScore()` composites four dimensions, each normalized 0–100 then weighted:
- **Build** 40% — build success/completion
- **Features** 30% — deterministic/AST checks
- **FixEfficiency** 15% — fewer fix attempts vs budget = better
- **Duration** 15% — faster vs budget = better

Then a **tier bonus** (easy ×1.0, medium ×1.1, hard ×1.25) rewards completing harder prompts; score is capped at 100.
**Why:** A single 0–100 number is primitive for a CI regression gate; each dimension is accountable in `score.md`. Emphasizing build + features (70%) over speed reflects that *correctness* matters more than speed for a code generator.

### 4.2 Diff — change detection across runs (M7)
**Decision:** `--before <dir> --after <dir>` loads two runs and produces improved / regressed / stable / new / removed per case.
**Why:** Enables A/B comparisons (e.g. model A vs B, same case) and regression review without reading raw JSON. This is the A/B capability (it compares two full runs).

---

## 5. Observability — why Langfuse, and how we wired it (O1)

### 5.1 Why Langfuse / why at all
The composite score tells you **how good**, but not **why**. When a hard case fails or a model regresses, we need the actual LLM calls + tool trajectory to debug. Without observability we were flying blind on failures.

**Choice of Langfuse:** it's an OpenTelemetry-first LLM tracing platform, and the repo already had `@langfuse/langchain`, `@langfuse/core`, `@langfuse/otel`, and `@langfuse/tracing` installed. LangChain model calls + `@langfuse/tracing`'s manual observations both bridge into one tracer, so we get automatic LLM generation capture plus manual grouping — no bespoke metrics pipeline.

### 5.2 The critical technical constraint — OTel bootstrap ordering
**Decision + why (this was a real discovery):** The Langfuse dark-cloud SDK (v5.x) is OpenTelemetry-based. Its `LangfuseSpanProcessor` and `NodeSDK` **must be imported/started before any model is constructed**, otherwise LangChain callback-handler spans and `@langfuse/tracing` observations don't nest under the same tracer — silent capture failure.

**How:** `observability/instrumentation.ts` runs as a **side-effect import** (importing it calls `startLangfuseInstrumentation()`). `client.ts` imports `"../observability/instrumentation"` *before* building any model, guaranteeing ordering. Note: `NodeSDK` requires `spanProcessors` (array), and `exportMode: "immediate"` is set so short-lived eval runs export promptly.

### 5.3 Hermetic by default, opt-in to cloud
**Decision:** Observability is **no-op when disabled**. `isLangfuseConfigured()` returns false when `LANGFUSE_ENABLED=0` or keys are absent. Eval runs stay hermetic unless explicitly wired up — we don't want every test firing traces to a third party.

### 5.4 One shared CallbackHandler (a hard-won gotcha)
**Decision:** A single process-wide `CallbackHandler` (`getLangfuseHandler()`), reused and attached to every model via `injectLangfuse(model)`.
**Why:** Fresh handler instances cause **silent capture failures** in Langfuse's LangChain integration. Reusing one handler per process is required for reliable capture. `injectLangfuse` wraps each model (Google, Groq, and now AIRouter) so every `model.invoke()` in the whole agent is auto-captured as a generation.

### 5.5 Per-case trace grouping
**Decision:** Each eval case runs inside `traceCase({runId, caseId, tier, prompt}, fn)` which:
- names the trace `run<runId>:<caseId>`
- sets `sessionId = runId`, `userId = caseId`, tags `["eval", tier]`, metadata `{runId, caseId, tier}`

**Why:** You can query Langfuse "give me all LLM calls for this specific case" and group all cases of a run under one session. Implemented via `@langfuse/tracing` `propagateAttributes` + `startActiveObservation`.
**How it snapshots reality:** the eval runner wraps `executeMainFlow` in `traceCase` (runner.ts), and `index.ts` calls `forceLangfuseFlush()` on finish/signal so a short-lived run isn't left partially exported.

### 5.6 Verified against Langfuse Cloud
**Decision/validation, not speculation:** Ran a case against Langfuse Cloud (`us.cloud.langfuse.com`); trace `runrun_mtbqt3dd:counter-basic` was ingested with **4 GENERATION observations** (real token counts captured). Cost showed `undefined` because the Langfuse project had no pricing config — tracing works end-to-end; cost metadata is a project-config concern, not ours.

### 5.7 The model-loop reality check (why Langfuse, not a rewritten graph)
**Documented fact from the code:** `executeWorkflow` is a **hand-written sequential loop**, not an actual LangGraph `StateGraph`. Langfuse still integrates cleanly because we attach (a) the `CallbackHandler` to `model.callbacks` at construction (in `client.ts`) and (b) `startActiveObservation()` per eval case. This was a deliberate scoping call: we didn't rewrite the agent into a real StateGraph for observability — we layered tracing on top of the existing loop.

---

## 6. Provider reality — the Groq dead-end and what it taught us

### 6.1 Why we left Groq (a real, measured wall)
**Decision:** Groq became structurally unusable for full baselines on this org's free tier:
- Every current Groq chat model on the free tier caps at **8k TPM**, but the agent's *planner node* sends single requests of ~**9.2k tokens**.
- `compound-mini` → internally `gpt-oss-120b` → same 8k cap; `qwen3.6-27b`/`gpt-oss-120b` cap at 8k; `gpt-oss-20b` at 80 TPM.
- None can accept the 9.2k-token planner request. This is **not** a tuning issue — it's structurally impossible on that tier.

### 6.2 Interim: Gemini free tier
Switched to `google/gemini-2.5-flash` (stable, fast, confirmed working via direct API). But its free tier caps at **20 requests/day**, so full 12-case baselines failed with 429 quota exhaustion — the reference runs in `PR_DESCRIPTION.md` show only `counter-basic` + `todo-basic` passing and the other 10 as `workflow_error`.

### 6.3 Final: AIRouter with `openai/gpt-4o-mini`
**Decision:** Migrate to AIRouter (`https://api.airouter.in/v1`), an OpenAI-compatible multi-provider router that:
- accepts the **~9.2k-token planner request** (validated: 200 in ~3s, not a 413 — the exact wall that killed Groq)
- supports tool-calling and 250+ catalog models
- is cheap — `openai/gpt-4o-mini` is a solid low-cost, fast, reliable tool-caller; full 12-case runs estimated **~$0.02–0.04** against a ~$1 budget

**Key probing lessons recorded:**
- The router's `<provider>/<model>` slug namespace differs per instance; `qwen/qwen3.6-flash` and `airouter/free` (free-plan only) are rejected with `plan_restricted`/`not supported` on our paid plan.
- `@langchain/openai` 1.5.x requires **`@langchain/core ^1.2.9`** (for the `@langchain/core/utils/gateway` subpath) — we had to bump core from `^1.2.3`.
- `ChatOpenAI` is pointed at AIRouter via `configuration: { baseURL }` and still gets `injectLangfuse()` so observability is unchanged across providers.
- `apps/evals/.env` (gitignored) holds the real `AIROUTER_API_KEY`; nothing secret is committed.

**Validated live on `airouter/openai/gpt-4o-mini`:** `counter-basic` 97/100 (3/3 features), `todo-basic` 98/100 (5/5 features).

---

## 7. Decisions made — B/C/D closed here

For the record — Tasks B, C, D that were open in §7 (see update below) are now **implemented**:

- **G** (regression gate) → `gate.ts` + `thresholds.json` + `--gate` (Task B), §10.1.
- **LLM-as-judge** → `judge.ts` + Quality dimension in `score.ts` (Task D), §10.3.
- **AST composition checks** → `ast:render:` / `ast:hook::top` in `ast.ts` (Task C), §10.2.

### Remaining open (deferred)
1. **Event trace viewer** — consume `runs/<runId>/events.jsonl` in the product UI.


---

## 8. Quick reference — how to run

```bash
cd apps/evals
bun run ./src/index.ts                 # all 12 cases
bun run ./src/index.ts --filter counter-basic   # one case
bun run ./src/index.ts --tier easy              # by tier
bun run ./src/index.ts --list                   # list cases
bun run ./src/index.ts --before <dir> --after <dir>  # A/B / diff two runs
bun run ./src/index.ts --gate thresholds.json        # evaluate + fail on regression
bun run ./src/index.ts --sleep-ms 30000              # rate-limit safe
bun run ./src/index.ts --clean                  # clear stale runs
```

**Provider switch:** edit `apps/evals/.env` → `LLM_PROVIDER=google|groq|airouter` + matching keys.
**Observability:** `LANGFUSE_ENABLED=0 bun run ./src/index.ts ...` to force a hermetic (no-cloud) run.

---

## 9. First full baseline — results & findings (run_mtcvg1vm)

First complete 12-case run on `airouter/openai/gpt-4o-mini`. **10/12 passed build, 43/53 features, average 86/100** (~10 min wall).

| Case | Tier | Status | Features | Score |
|---|---|---|---|---|
| counter-basic | easy | passed | 3/3 | 99 |
| landing-page | easy | passed | 5/5 | 98 |
| todo-basic | easy | passed | 5/5 | 95 |
| dashboard-cards | med | passed | 2/6 | 85 |
| weather-display | med | passed | 3/5 | 95 |
| multi-page-nav | med | passed | 5/6 | 100 |
| product-grid | hard | passed | 6/6 | 100 |
| analytics-charts | hard | passed | 5/5 | 100 |
| kanban-board | hard | passed | 4/6 | 100 |
| blog-crud | hard | passed | 5/6 | 100 |
| crud-contacts | hard | **workflow_error** | — | 29 |
| recipe-finder | hard | **workflow_error** | — | 29 |

### 9.1 Product-agent defect: the fix-loop blind spot
Both failures share a **single systemic agent bug** (in `apps/control/src/agent/tool/code/intelligentErrorFixer.ts`), not an eval-harness issue:

1. **Hallucinated shadcn imports.** The agent emits wrong-case / wrong-path shadcn imports — `import Input from './ui/input'` (lowercase, missing file) or `import { ... } from 'src/components/ui'` (a *directory*, not a module). Vite fails with `ENOENT: .../ui/input` / `EISDIR: illegal operation on a directory`. The template has no barrel `index.ts` for `ui/`, so case-tracking matters.
2. **`replaceInFile` oldStrings are guessed, so they always miss.** The fixer builds `oldString` from the *error message*, not from reading the live file. When its transcription differs from the real import literal, `replaceInFile` returns `success:false` ("String not found") **every attempt → guaranteed retry loop.**
3. **JSON-parse fragility compounds it.** On 2 of 4 attempts the fix-plan response failed JSON parsing (`intelligentErrorFixer.ts:372/377` — tail-comma strip), degrading to a useless blind `bun install` (`executeCommand`) that can't fix an import.

**Suggested agent fix (triage, not yet implemented):** the fixer should `read`/`grep` the target file to obtain the *actual* import line before issuing `replaceInFile`, and for missing-module failures it should **scaffold the missing file** (e.g. create `ui/input.tsx` with a pass-through `Input`), rather than guessing an edit that cannot match.

### 9.2 Baseline weaknesses that the next features target
- `dashboard-cards`/`weather-display` pass the build yet miss several greps (`mock`, `users`, `revenue`, `search`).
- `multi-page-nav`/`blog-crud` import react-router but fail `ast:jsx:Route` — they likely render routes via object config rather than a literal `<Route>`.
- These are exactly where **AST composition checks** (component-renders-component) and **LLM-as-judge quality** add signal beyond build+presence.

---

## 10. Foundation locked: regression gate (B), AST composition (C), LLM-as-judge (D)

The eval foundation is complete and folded into the baseline pipeline. Each hardens the gate in a different way: **build+score** (what we had), **deterministic AST checks** (structural, free), and **LLM-as-judge** (quality beyond greps).

### 10.1 Task B — regression gate (`gate.ts`, `thresholds.json`, `--gate`)
Protects against silent quality regressions on model/agent upgrades. Floors are derived from the baseline (`baseline − 10`, average floor 80) so the gate is meaningful but not flaky.

- `thresholds.json` defines per-case `scoreFloor` and an `averageFloor`.
- `gate.ts` → `evaluateGate(run, thresholds)` returns `{ pass, breaches }`; `renderGate` prints it; `toGateCases` normalizes a run into gate cases.
- `index.ts` wires `--gate <file>`; on breach it prints the table and exits **1** (CI fails). Verified: PASS on baseline, FAIL when counter-basic is forced to 80 (< floor 89).

### 10.2 Task C — AST composition + top-level hooks (`ast.ts`)
Hardens M6 from "does `<X>` exist" to "does the app actually compose correctly".

- `renders: Map<string, string[]>` per file: which host component renders which child component.
- `topLevelHooks: Set<string>`: hooks called directly in a component body, not inside a handler/nested function.
- New check forms:
  - `ast:render:<Child>` — some component renders `<Child>`.
  - `ast:render:<Parent>:<Child>` — `<Parent>`'s JSX contains `<Child>` (composition).
  - `ast:hook:<hook>:top` — `<hook>` is called at the top level of a component body.
- Validated against real TSX fixture: catches correct composition, rejects cross-parent and handler-nested hooks (`React.useState` inside `onClick` correctly fails `:top`).

### 10.3 Task D — LLM-as-judge quality (`judge.ts` + Quality dimension in `score.ts`)
Adds a rubric-based *Quality* dimension on top of the deterministic checks. This is **not** A/B testing (that stays in diff mode) — it grades absolute quality of a single build.

- `judge.ts`: `judgeCase(case, projectDir, model)` sends the original prompt + a bounded snapshot of `src/` (`snapshotProject`, capped ~24k chars) to the model with a strict JSON rubric; parses and clamps to 0-1 for `fulfilled`, `coherence`, `codeQuality`, `reusability` + free-form `notes`.
- Runs **only after a passing build + passing checks** (don't waste judge calls on broken apps). Degrades safely (`failedJudgeResult`) on errors.
- Uses the same AIRouter/gpt-4o-mini model (cheap; ~1 tiny call per case → negligible against the ~$1 budget).
- `score.ts`: `DEFAULT_WEIGHTS` rebalanced to make room — build 0.35, features 0.25, fix 0.10, duration 0.10, **quality 0.20**. Missing/invalid judge is neutral (50) so it never unfairly helps or penalizes.
- `report.ts` renders a **Judge quality** table per case; `renderScoreTable` and summary show `q:`.
- Empirically validated against AIRouter: good counter → all 1.0 (reusability 0, correctly), "Hello World" vs counter prompt → all 0.0.

**Cost note:** judge reuses the existing `client.ts` model so it inherits Langfuse + AIRouter. It lands as a separate generation on the shared callback handler (not nested under the case trace name) — acceptable; traceable in Langfuse.


---

## 11. Session fixes + verified second baseline (run_mtdruu8x)

Two empirical bugs surfaced when Task D was wired into the real pipeline � both fixed.

### 11.1 Judge never reached the scoreboard
index.ts unpacked unCase as { result, metrics, checks } and **dropped judge**, so computeScore always saw no judge ? Quality locked at neutral 50. The judge DID run (verified in runner logs) but its value never made it to evaluated. Fixed by passing judge through into the evaluated object (index.ts:229).

### 11.2 End-of-run hang blocked CI
After all work finished (scoreboard printed) the process would hang forever in the inally block's orceLangfuseFlush(): the OTel/Langfuse exporter + open AIRouter keep-alive kept the event loop alive. Two-part fix:
- Bound the final flush with Promise.race(forceLangfuseFlush, 5000ms) so it can never stall a run.
- Add explicit process.exit(process.exitCode || 0) at the end of main() (the exporter leaves handles that keep Node alive).

Additionally, judge.ts now wraps the LLM call in a 30s timeout so a single stuck judge can't stall the whole suite.

### 11.3 Verified second baseline � judge active
Full 12-case rerun post-fix (run_mtdruu8x): **10/12 passed build, 44/54 features, average 85/100**. 	hresholds.json regenerated from these scores (floors = baseline - 10).

| Case | Tier | Status | Overall |
|---|---|---|---|
| counter-basic | easy | passed | 97 |
| todo-basic | easy | passed | 97 |
| landing-page | easy | passed | 98 |
| dashboard-cards | med | passed | 77 |
| weather-display | med | **workflow_error** | 28 |
| multi-page-nav | med | passed | 93 |
| kanban-board | hard | passed | 100 |
| crud-contacts | hard | **workflow_error** | 32 |
| analytics-charts | hard | passed | 100 |
| blog-crud | hard | passed | 100 |
| product-grid | hard | passed | 100 |
| recipe-finder | hard | passed | 100 |

Notes:
- **Judges landed where checks fully passed** (counter 100, landing 98, todo 95, recipe 80); partial-check and failed-build cases stay neutral 50 (no judge call wasted).
- Case variance confirms the system-agent fix-loop bug is **nondeterministic**: recipe-finder now passes (6/6), but weather-display/crud-contacts now fail as workflow_error (the ui/input + ui/ directory hallucination from �9.1).
- Gate now uses the **tier-bonused overall** scores with floors baseline-10; average floor 75.

### 11.4 Unit tests
Added un test (src/*.test.ts) � 24 tests covering AST composition (+ top-level hooks incl. the handler-nested negative), gate pass/breach logic, and score weight math / judge Quality dimension. un run test passes.
