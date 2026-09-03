# Langfuse trace review

Every agent run (eval case or user prompt) should produce one Langfuse trace when `LANGFUSE_PUBLIC_KEY` + `LANGFUSE_SECRET_KEY` are set and `LANGFUSE_ENABLED` is not `0`. Eval JSON includes `traceId` so a failing case maps to that trace.

## What a trace contains

- Phases: Security → TemplateFacts → Planning → ReAct Agent → StitchApp → Build → Repair (if any) → Final Result
- Each ReAct step: model call, latency, token usage, tool name, sanitized args/result, changedFiles
- Retrieval tools (listDir, grepSearch, readFile) are nested under a parent "Retrieval" span
- Build: status, duration, diagnosticCategory, error count
- Repair: per-attempt diagnostics, edits, re-validation build
- Final Result: executionStatus, buildStatus, repairAttempts, agentSteps, toolCalls

Correctness still comes from evals (build + checks + judge), not from Langfuse.

## Querying in Langfuse

### By trace
Use `traceId` from eval JSON or server logs to open a specific run directly.

### By metadata
All metadata is filterable in the Langfuse trace list:
- `agentMode`: `"eval"` or `"production"`
- `buildStatus`: `"success"` or `"errors"`
- `executionStatus`: `"completed"`, `"failed"`, `"crashed"`
- `error`: free-text error message

### By tags
Traces are tagged with `["eval", "<tier>"]` for eval runs and `["production"]` for prod.

### By span name
Filter by observation name to isolate specific phases:
- `"Retrieval"` — all file reads and searches
- `"Build"` — all build attempts (initial + post-repair)
- `"Repair N"` — individual repair attempts
- `"ReAct Step N"` — individual reasoning steps
- `"StitchApp"` — template stitching

### Token usage
Each ReAct Step observation includes `promptTokens`, `completionTokens`, and `totalTokens` in its metadata. Sum across steps for total usage per run.

## Blind spots (not agent failures)

These will **not** appear as a failed ReAct span:

1. **Orchestrator response-resolver race** (spec-06 §1) — the agent can finish with a clean trace while the user's HTTP request times out because the response was delivered to a different waiter for the same `projectId`. Signature: good Langfuse trace + user-facing timeout on create/prompt/build/run.
2. **Redis stream with no redelivery** (spec-06 §2) — if the prompt message is stuck in the pending-entries list, the control agent never starts. Signature: hung request and **no Langfuse trace at all**.

Do not spend an incident looking for a missing trace until those two platform paths are ruled out.
