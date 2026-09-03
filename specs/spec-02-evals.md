# Spec 2 — Evals for the New Agent

**Status:** Proposed
**Scope:** `apps/evals`
**Repository:** `Manav2209/lovable-v0`
**Related specs:** [`spec-01-agent-react-migration.md`](./spec-01-agent-react-migration.md) (produces the contract this stage consumes), [`spec-03-observability-langfuse.md`](./spec-03-observability-langfuse.md) (consumes this stage's `traceId` field), [`spec-06-platform-reliability.md`](./spec-06-platform-reliability.md) (platform bugs that can masquerade as eval failures — see §7)

This is Stage 2 of the original three-stage plan. `apps/evals` is already the most mature part of the codebase — it's the only part with unit tests (`ast.test.ts`, `gate.test.ts`, `score.test.ts`) — so this stage is genuinely a migration, not a rebuild. Content unchanged from the original plan except where marked **[REVIEW]**.

**Do not start this until Spec 1's acceptance criteria are met.** Evaluating an unstable agent contract just produces noisy, unreproducible numbers.

---

## 1. Objective

Modify the evaluation system so it evaluates the **new agent contract**, not the old workflow implementation.

```text
Eval → old WorkflowState        becomes        Eval → stable AgentRunResult
```

The current eval dataset and deterministic checks are largely reusable.

---

## 2. Freeze the Legacy Baseline

Before changing eval behavior:

```text
Run OLD agent → save results
```

Preserve: run ID, per-case results, build status, feature scores, LLM judge scores, fix attempts, duration, overall score. This becomes the old-agent baseline for the OLD vs NEW comparison in §8.

---

## 3. Introduce `AgentRunResult`

Do not make `apps/evals` depend directly on the new internal ReAct/LangGraph implementation.

```ts
type AgentRunResult = {
  runId: string;
  caseId: string;
  projectId: string;

  status: "completed" | "build_failed" | "agent_error" | "timeout" | "crashed";
  completed: boolean;

  build?: { status: "passed" | "failed" | "not_run"; diagnostics?: string };
  repair?: { attempts: number; maxAttempts: number };
  agent?: { steps: number; toolCalls: number; durationMs: number };
  files?: { created: number; modified: number; deleted: number };

  dependenciesAdded: number;

  error?: string;
  timestamp: number;
};
```

The evaluator consumes this abstraction. The agent implementation behind it can change later without another eval rewrite.

**[REVIEW]** Add one optional field now, even though it isn't populated until Spec 3:

```ts
  traceId?: string;
```

Reserving the field here means Stage 3 doesn't require a second schema change to `AgentRunResult` later — see spec-03 §6.

---

## 4. Keep Existing Dataset and Checks

Existing cases (`counter-basic`, `todo-basic`, `landing-page`, `dashboard-cards`, `weather-display`, `multi-page-nav`, `kanban-board`, `crud-contacts`, `analytics-charts`, `blog-crud`, `product-grid`, `recipe-finder`) provide useful easy/medium/hard coverage — keep them initially.

Keep deterministic assertions (`plain string`, `file:<path>`, `dep:<n>`, `ast:<...>`). These remain important — do not replace them with LLM judgment.

---

## 5. Separate Evaluation Dimensions

```json
{
  "executionStatus": "completed",
  "buildStatus": "passed",
  "checksStatus": "failed",
  "judgeStatus": "valid"
}
```

Better than treating `passed_build` as equivalent to overall success.

---

## 6. Add ReAct Metrics and Workspace Diff Metrics

Track: agent steps, total tool calls, tool calls by tool, read operations, mutation operations, build count, repair attempts, time to first tool call, total duration. Derived: `tool_calls / successful case`, `reads_before_first_edit`, `edits / successful case`, `builds / case`, `repair rate`. Initially diagnostic, not hard score penalties.

```ts
type WorkspaceDiff = {
  created: string[];
  modified: string[];
  deleted: string[];
};
```

Use it to catch massive rewrites, unexpected deletions, unrelated modifications, excessive package changes — this matters specifically because the ReAct agent should be good at incremental modification, and a diff is the cheapest way to prove (or disprove) that it is.

---

## 7. Add Repository-Modification Eval Cases

**[REVIEW]** Note before adding these: the current dataset is greenfield-generation-only, which means it has never exercised anything downstream of a *second* prompt against the same project. Two platform-level bugs found in the broader review only surface on repeated/concurrent requests against the same project — an orchestrator response-resolver race (spec-06 §1) and a lack of stream-message redelivery (spec-06 §2). If repository-modification cases start failing intermittently in a way that doesn't reproduce locally, check whether it's actually an agent quality regression or one of those two platform bugs before spending time tuning the agent. Fixing spec-06 first, or at minimum in parallel, will keep this new case category's signal clean.

Recommended cases: `edit-existing-app`, `add-page-to-existing-router`, `add-component-using-existing-library`, `modify-existing-component`, `preserve-existing-functionality`. These exercise the primary advantage of the ReAct architecture over the old planner.

---

## 8. Add Agent Behavior Checks

Informational/soft checks: `inspect-before-edit`, `no-stitch-happy-path`, `bounded-agent`, `single-validation-build`, `reactive-tool-usage`.

- **inspect-before-edit** — relevant files were inspected before mutation.
- **no-stitch-happy-path** — a successful generation should not depend on `stitchApp`.
- **bounded-agent** — step/tool limits respected.
- **single-validation-build** — detect unnecessary repeated validation builds.

Start these as diagnostics before turning them into strict gates.

---

## 9. Improve Scoring

Keep the existing product-oriented score initially: `Build 35% / Features 25% / Fix efficiency 10% / Duration 10% / Quality 20%`.

Conceptually split results into:

```text
PRODUCT QUALITY          AGENT EFFICIENCY
----------------          ----------------
build                      duration
features                   tool calls
quality                    steps
                           fix attempts
```

Do not immediately punish the ReAct agent heavily for additional tool calls — first prove it improves reliability and quality.

---

## 10. Compare OLD vs NEW

Run identical cases against `OLD_AGENT` and `NEW_AGENT`. Compare case, old/new score and delta, old/new duration, old/new fix attempts, old/new tool calls. Classify each case: `improved / unchanged / regressed / failed`.

Pay special attention to: build regressions, feature regressions, existing-app edits, unnecessary rewrites, tool loops.

---

## 11. Regression Gate Improvements

The gate must not pass an empty or incomplete run:

```text
0 scored cases → gate failure / invalid run
```

Distinguish `judge invalid` from `product failure`. The gate should evaluate meaningful completed results only.

---

## 12. Stage 2 Acceptance Criteria

- Existing eval cases run against the new agent.
- Eval runner does not depend directly on old workflow internals.
- `AgentRunResult` is the stable execution contract, with `traceId?` reserved for Spec 3.
- ReAct metrics are recorded.
- Workspace changes are measurable.
- Existing deterministic checks still work.
- New repository-edit cases exist, and their failures have been checked against spec-06's known platform-level failure modes before being attributed to agent quality.
- OLD vs NEW comparison is possible.
- Regression gate handles empty/incomplete runs correctly.
- Product quality and agent efficiency are separately visible.

At this point, the agent and eval contracts are stable enough for observability instrumentation (Spec 3).
