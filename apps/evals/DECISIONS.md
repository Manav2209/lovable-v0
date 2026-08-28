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

## 7. Decisions still open / not yet implemented

(For completeness — the roadmap, some deliberately deferred.)
1. **Full 12-case baseline** on AIRouter — establishes the reference scores/artifacts the regression gate needs. Deferred by explicit request; harness + provider are ready.
2. **LLM-as-judge** — a rubric-based *Quality* dimension on top of deterministic checks. Note: this is **not** A/B testing; A/B is already available via diff mode (`--before`/`--after`). Two architecture options under consideration: (a) inline judge feeding `score.md`, (b) Langfuse-native eval (dataset/LLM-as-judge in their UI).
3. **AST composition checks** — component-renders-component reference graph; stricter "hook called at top level of a component" validation. Hardens M6 beyond presence.
4. **CI regression gate** — wire `score.md` thresholds into CI so a model/agent upgrade can't silently regress quality.
5. **Event trace viewer** — consume `runs/<runId>/events.jsonl` in the product UI.

---

## 8. Quick reference — how to run

```bash
cd apps/evals
bun run ./src/index.ts                 # all 12 cases
bun run ./src/index.ts --filter counter-basic   # one case
bun run ./src/index.ts --tier easy              # by tier
bun run ./src/index.ts --list                   # list cases
bun run ./src/index.ts --before <dir> --after <dir>  # A/B / diff two runs
bun run ./src/index.ts --sleep-ms 30000         # rate-limit safe
bun run ./src/index.ts --clean                  # clear stale runs
```

**Provider switch:** edit `apps/evals/.env` → `LLM_PROVIDER=google|groq|airouter` + matching keys.
**Observability:** `LANGFUSE_ENABLED=0 bun run ./src/index.ts ...` to force a hermetic (no-cloud) run.
