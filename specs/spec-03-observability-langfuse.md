# Spec 3 — Langfuse Observability

**Status:** Proposed
**Scope:** `apps/control`, `apps/evals`
**Repository:** `Manav2209/lovable-v0`
**Related specs:** [`spec-01-agent-react-migration.md`](./spec-01-agent-react-migration.md), [`spec-02-evals.md`](./spec-02-evals.md) (`AgentRunResult.traceId` defined there), [`spec-06-platform-reliability.md`](./spec-06-platform-reliability.md) (known blind spot — see §8)

This is Stage 3 of the original three-stage plan. **Do not start until Spec 1 and Spec 2's acceptance criteria are both met.** Observability instruments a contract — it can't stabilize one that hasn't settled yet, and building traces around an agent whose tool results and status semantics are still shifting means rebuilding the trace schema every time they do.

---

## 1. Objective

Instrument the stabilized agent and eval system with Langfuse so every generation can be explained from prompt to final result. The existing eval runner already has a `traceCase(...)` integration point — extend that foundation rather than building a parallel telemetry system.

---

## 2. Trace Per Agent Run

Every agent execution creates one top-level trace: `Eval Case / User Request → Langfuse Trace`.

Recommended trace metadata: `runId`, `caseId`, `projectId`, `agentVersion`, `agentMode`, `templateVersion`, `prompt`, `environment`.

Avoid putting secrets or sensitive file contents into metadata — see §9.

---

## 3. Trace Major Agent Phases

```text
Trace
 ├── Security
 ├── TemplateFacts
 ├── Retrieval
 ├── Planning
 ├── ReAct Agent
 ├── Build
 ├── Repair
 └── Final Result
```

Retrieval can contain multiple operations: `listFiles`, `searchFiles`, `readFile`.

---

## 4. Trace Every ReAct Step

```text
ReAct Step 1 — LLM generation → tool call: searchFiles → tool result
ReAct Step 2 — LLM generation → tool call: readFile     → tool result
ReAct Step 3 — LLM generation → tool call: updateFile   → tool result
```

Capture: step number, model, latency, token usage, tool name, tool arguments, tool result, changed files.

Do not expose sensitive secrets or unnecessary full file contents (see §9).

---

## 5. Trace Build and Repair

Build is its own span: `command`, `duration`, `status`, `diagnostics summary`.

Repair is grouped separately, per attempt: `diagnostics`, `relevant inspection`, `edits`, `validation`.

This lets you distinguish **"agent generated bad code"** from **"agent generated bad code but repaired it successfully"** — two very different signals that a flat pass/fail obscures.

---

## 6. Connect Evals to Langfuse

Every `AgentRunResult` carries the `traceId?` field reserved in spec-02 §3:

```text
Eval Case → Agent Run → AgentRunResult → Langfuse traceId → Deterministic checks → LLM judge → Score
```

This lets a failing eval be traced directly to the exact agent execution that produced it.

---

## 7. Use Langfuse for Observability, Not Correctness

Do not make Langfuse the source of truth for product correctness. Correctness comes from: Build + AST checks + File checks + Dependency checks + LLM judge (all owned by Spec 2).

Use Langfuse to answer: What happened? Why did it happen? Which step caused the failure? Which tool caused the regression? How much did the agent use?

---

## 8. Known Blind Spot **[REVIEW — new section]**

Two platform-level bugs live outside the agent boundary this migration covers, and neither will show up in an agent trace even after this stage ships:

- **Orchestrator response-resolver race** (spec-06 §1) — if it fires, the *agent run itself* can complete cleanly (clean trace, correct final code) while the *user's HTTP request* still times out, because the response got routed to a different concurrent request for the same project. A clean trace next to a user-reported timeout is the signature of this bug, not an agent failure.
- **Redis stream messages with no redelivery** (spec-06 §2) — a message stuck in the pending-entries list produces a hung request with nothing in Langfuse at all, because the agent run that would produce a trace never started.

Fixing spec-06 isn't a prerequisite for shipping this stage, but write this down explicitly (e.g. in the trace-review runbook) so a future on-call engineer doesn't spend an hour searching Langfuse for a trace that was never going to exist.

---

## 9. Useful Langfuse Metadata

**Trace level:** `agentVersion`, `model`, `templateVersion`, `caseId`, `runId`, `agentMode`.
**ReAct-step level:** `stepNumber`, `toolName`, `toolSuccess`, `duration`, `changedFiles`.
**Build level:** `buildStatus`, `duration`, `diagnosticCategory`.
**Final result level:** `executionStatus`, `buildStatus`, `checksScore`, `judgeScore`, `repairAttempts`, `agentSteps`, `toolCalls`.

This creates a direct link between runtime behavior and evaluation outcomes.

**[REVIEW]** This is also where the security review's "avoid unnecessary logging of full file contents" (see spec-05) and this stage's own "avoid secrets or sensitive file contents" guidance converge — apply one sanitization pass before anything gets written to a trace span, not two separate ad hoc ones. Env-var-shaped values in tool arguments/results should go through the same stripping logic already used for subprocess env sanitization in `security.ts`, rather than a second reimplementation.

---

## 10. Observability Questions We Should Be Able to Answer

- **Failure analysis:** Why did this case fail?
- **Tool analysis:** Which tools cause the most failures?
- **Retrieval analysis:** Did the agent inspect the right files before editing?
- **Repair analysis:** Which build errors require the most repair attempts?
- **Efficiency analysis:** Which cases cause excessive tool calls?
- **Regression analysis:** Why did NEW_AGENT score lower than OLD_AGENT?
- **Quality analysis:** Which agent behaviors correlate with higher final quality?

---

## 11. Stage 3 Acceptance Criteria

- Every agent run has a Langfuse trace.
- ReAct steps are visible.
- Tool calls/results are visible.
- Build and repair spans are visible.
- Eval results can be linked to traces via `traceId`.
- Agent metrics are queryable.
- Sensitive data is not unnecessarily logged (one shared sanitization pass, not ad hoc per-span).
- Failed generations can be debugged from the trace without reproducing them manually.
- The orchestrator/Redis blind spot (§8) is documented somewhere an on-call engineer will find it.

---

## 12. Final Architecture After Specs 1–3

```text
                         USER / EVAL CASE
                                ↓
                           ┌──────────┐
                           │ Langfuse │
                           │  Trace   │
                           └────┬─────┘
                                ↓
                           SECURITY
                                ↓
                        TEMPLATE FACTS
                                ↓
                     REPOSITORY RETRIEVAL
                                ↓
                           SHORT PLAN
                                ↓
                  ┌───────────────────────────┐
                  │       REACT AGENT         │
                  │  inspect → decide → edit  │
                  │      → observe → repeat   │
                  └─────────────┬─────────────┘
                                ↓
                              BUILD
                                ↓
                        ┌───────┴───────┐
                       PASS            FAIL
                        │               │
                        ↓               ↓
                     PREVIEW       REPAIR AGENT → BUILD → FINAL RESULT
                                                              ↓
                                 ┌──────────────────────┬────────────────────┐
                                 ↓                       ↓                    ↓
                            Build Check          Feature Checks        LLM Judge
                                 │                       │                    │
                                 └──────────────────────┬────────────────────┘
                                                        ↓
                                                   Eval Score
                                                        ↓
                                                  Regression Gate
```

---

## 13. Recommended Cross-Spec Implementation Order

```text
STAGE 1 (spec-01)             Make the agent correct.
       ↓
STAGE 2 (spec-02)             Make the evaluation accurate.
       ↓
STAGE 3 (spec-03, this doc)   Make the system observable.
```

Do not use observability to compensate for an unstable agent contract. Do not redesign eval scoring before the agent architecture is stable. Do not redesign the agent around metrics that have not yet been measured.

`spec-04`, `spec-05`, and `spec-06` are independent of this ordering and can proceed in parallel at any point — see each for scope and rationale.
