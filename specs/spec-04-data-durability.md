# Spec 4 — Workspace Data Durability

**Status:** Proposed
**Scope:** `apps/control` (persistence hook), `apps/orchestator` (pod spec / restore-on-init), `packages/r2`
**Repository:** `Manav2209/lovable-v0`
**Related specs:** [`spec-01-agent-react-migration.md`](./spec-01-agent-react-migration.md) §10 (integration point)
**Priority:** Critical — recommended to start in parallel with Spec 1, not after it.

---

## 1. Problem

A project's generated/edited code exists **only** on the ephemeral disk of its control pod.

- `apps/orchestator/src/handler/project.ts` mounts the project workspace as `emptyDir: {}` — storage tied to the pod's lifetime, wiped on eviction, node restart, or rescheduling.
- `apps/control/src/agent/tool/r2/push.ts` (`pushNode`) exists and would upload the workspace to R2, but its call site is commented out in `apps/control/src/agent/graphs/workflow.ts`.
- R2 is currently read-only from the agent's perspective: it seeds the initial template (`pullTemplatefromR2`) and nothing else. There is no active code path that writes generated work back to durable storage.

**Impact:** any pod restart — OOM kill, node drain, manual reschedule, cluster maintenance — silently and permanently destroys the user's generated application. The database row and conversation history survive; the code does not. Nothing in the current system surfaces this loss to the user or an operator.

---

## 2. Objective

Every successful build durably persists the full workspace to R2 before the request that produced it is considered complete, and a project pod that starts up (including a *restart* of an existing project, not just first creation) restores from the latest persisted state instead of always falling back to the bare template.

---

## 3. Target Flow

```text
CURRENT
Template (R2, read-only) → pod emptyDir → [agent runs] → nothing persisted → pod dies → work lost

TARGET
Latest workspace (R2) or Template (R2, first run) → pod emptyDir
    → [agent runs] → build passes → push full workspace to R2
    → pod dies → next pod init pulls latest persisted (build-passing) workspace, not bare template
```

```text
Pod Init
    ↓
Does a persisted workspace exist for this projectId in R2?
    │
    ├── yes → pull latest persisted workspace
    │
    └── no  → pull base template (current behavior, unchanged)
```

---

## 4. What Triggers a Push

**Decision: push after each successful build.** Not per-tool-call, not debounced — tied to the build gate specifically.

```text
ReAct Agent → Build → PASS → push workspace to R2 → (request complete / next step)
                    → FAIL → no push, repair loop continues
```

Rationale:

- Aligns directly with Spec 1's build gate (§13 of spec-01) — a build pass is already the point at which the workspace is confirmed to be in a coherent, buildable state. Pushing here means R2 never holds a known-broken intermediate state, which also makes the restore-on-init path in §5 safe by construction: whatever's in R2 for a project is, by definition, the last state that actually built.
- It's the smallest change that closes the worst-case scenario — a fully-generated, working app disappearing because a pod happened to restart between "build passed" and "user opens the preview" — and it's a natural fit for where `pushNode` already exists in the workflow graph, right after the build gate.
- It avoids the R2-traffic and partial-state questions that per-tool-call or debounced pushing would raise (see Non-Goals §8) — every push is a complete, validated snapshot, not a fragment of an in-progress edit.

**Failed builds don't push.** If the agent's changes fail to build, the last-known-good (previously pushed) state in R2 is left untouched. This means a pod restart mid-repair-loop loses only the in-progress, not-yet-passing repair attempt — not the project. That's an acceptable trade-off: the alternative (persisting broken intermediate states) would mean restore-on-init could hand a fresh pod a workspace that doesn't build, which is worse than falling back to the last good state.

**What to push:** full workspace re-upload on every push (matching what `pushNode` already does today). Changed-files-only, incremental pushes are explicitly out of scope for this version — see §8.

---

## 5. Restore-on-Init

Currently, pod init always calls `pullTemplatefromR2` unconditionally. Change this to check for an existing persisted workspace for the `projectId` first:

```text
if persisted workspace exists for projectId:
    pull persisted workspace
else:
    pull base template  (unchanged — first run for this project)
```

This matters independent of the push-trigger question above: even a naive "push on every successful build, restore on init" pair closes the critical data-loss case, because a pod that gets rescheduled will come back up with the last known-good state instead of a blank template.

---

## 6. Failure Handling

- If the post-build push fails (R2 unavailable, network blip), do not fail the user-facing request that triggered the build — log it and retry with backoff, but don't block the response the user is waiting on. A push failure should degrade to "we'll lose this specific build's increment if the pod dies before the next successful push," not "the user's request fails because R2 hiccuped." Since the previous push is untouched, restore-on-init still has *something* valid to fall back to — just one build older than the latest.
- If a restore-on-init pull fails, fall back to the base template rather than failing pod startup entirely — surface a clear log line so this is diagnosable, since silently falling back to template after a restore failure looks identical to "no persisted state existed" from the outside.
- Add a metric/log line distinguishing the three init paths (`restored`, `fresh template`, `restore attempted but failed → fell back to template`) — without this, an operator can't tell "this is a brand new project" from "we just silently lost someone's work and recovered to a blank slate," which is exactly the failure mode this spec exists to catch.

---

## 7. Acceptance Criteria

- A project that has completed at least one successful build survives a pod restart with its generated code intact.
- The push is wired to fire specifically on build success, not on every tool call and not on a timer — a failed build does not overwrite the last good persisted state.
- `pushNode` (or its replacement) is called from an active code path, not dead/commented-out code.
- Pod init checks for and restores from persisted workspace state before falling back to the base template.
- Push failures do not block or fail the user-facing request, and leave the previous (still-valid) persisted state in place.
- The three init outcomes (restored / fresh / restore-failed-fallback) are distinguishable in logs or metrics.
- Behavior is verified by an actual pod-restart test (kill the pod mid-project after a successful build, confirm the next pod comes back with the work intact), not just unit-level mocking of the R2 client.

---

## 8. Non-Goals

```text
Per-tool-call or debounced push (deferred — see below)
Changed-files-only / incremental push (deferred — see below)
Full version history / point-in-time snapshots
Git-like diffing or branching of generated workspaces
Multi-region replication
Conflict resolution for concurrent writes to the same project
                (the orchestrator concurrency issue in spec-06 §1 should be
                 fixed for its own sake, but this spec assumes single-writer
                 workspace state, not concurrent-writer merge semantics)
```

Per-tool-call pushing and incremental (changed-files-only) uploads were considered and deliberately deferred, not forgotten: build-triggered, full-workspace push is the simplest version that closes the critical data-loss case, and it keeps every persisted snapshot in R2 guaranteed-buildable by construction. Revisit tighter granularity only if real usage shows the "lose an in-progress repair attempt on pod death" gap in §4 actually matters in practice — not preemptively.
