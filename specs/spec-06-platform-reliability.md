# Spec 6 — Platform Reliability (Orchestration, Messaging, Test Coverage)

**Status:** Proposed
**Scope:** `apps/orchestator`, `packages/shared-redis`, cross-cutting test coverage for `apps/control` and `apps/orchestator`
**Repository:** `Manav2209/lovable-v0`
**Related specs:** [`spec-02-evals.md`](./spec-02-evals.md) §7 (these bugs can masquerade as agent regressions), [`spec-03-observability-langfuse.md`](./spec-03-observability-langfuse.md) §8 (blind spot these bugs create), [`spec-01-agent-react-migration.md`](./spec-01-agent-react-migration.md) §10 (the safety-check hardening whose test coverage belongs here)

This spec is independent of Specs 1–3 and can proceed in parallel with any of them. It fixes correctness/reliability bugs in the plumbing *around* the agent, not the agent itself — which is exactly why they're easy to misdiagnose as agent problems if left unfixed while the agent is being rewritten.

---

## 1. Orchestrator Response-Resolver Race

**Problem:** `apps/orchestator/src/index.ts` uses `Map<projectId, resolver>` (`serverResponses`, `controlResponses`) to correlate outbound requests with their async responses — one pending resolver **per project**, not per request. `waitForControl(projectId)` is called by both `buildProject()` and `handlePrompt()`; if two control-plane operations for the same project are in flight concurrently (a manual Build racing the auto-fired initial prompt, or a double-submitted prompt), the second call's `.set()` silently overwrites the first resolver. The first caller's promise is orphaned until its own timeout fires; the second caller may resolve with a response meant for the first request.

The team has already independently flagged this class of bug: `apps/backend/src/lib/orchestatorListener.ts:31` has `// TODO: Resolve waiting promise correlated by jobId (not just projectId)`.

**Fix:** key resolvers by `jobId` instead of `projectId`. `jobId` is already generated (`createRandomJobId()`) and threaded through envelopes on the backend side — extend that same identifier through the orchestrator's request/response correlation. Alternatively, adopt the FIFO-queue pattern already implemented correctly in `apps/backend/src/lib/responseManager.ts` (an array of resolvers per key, shifted on resolve) in place of the single-slot Map — either fixes the collision, `jobId`-keying is the more precise fix and avoids the ordering-assumption the queue approach depends on.

---

## 2. Redis Stream Message Redelivery / Dead-Letter Handling

**Problem:** `packages/shared-redis/index.ts`'s `readGroupLoop` only `XACK`s a message after its handler resolves successfully. If a handler throws — a bug, an OOM mid-handler, a malformed payload — the message stays in the consumer group's Pending Entries List (PEL) with no reclaim logic (`XCLAIM`/`XAUTOCLAIM`) anywhere in the codebase, and nothing re-reads the PEL on restart (`XREADGROUP ... >` only surfaces new messages). A failed message is effectively retried zero times and then becomes invisible — visible only via manual `XPENDING` inspection.

**Impact:** since build results, run results, and prompt responses each currently block an HTTP request for up to several minutes on the other end, a stuck PEL entry silently becomes a hung request with no operator-visible signal explaining why.

**Fix:**
- Add a periodic `XAUTOCLAIM` sweep per consumer group: claim messages that have been pending longer than a threshold (e.g. 2× the expected handler duration) and hand them to a fresh consumer for retry.
- Bound the retry count (track delivery count via `XCLAIM`'s idle-time/retry metadata, or a side counter) and route messages that exceed it to a dead-letter stream instead of retrying forever.
- Emit a metric or log line for PEL depth per stream, so a growing backlog is visible before it becomes a pile of silently-hung user requests.

---

## 3. Test Coverage

**Problem:** the only tests in the repository live in `apps/evals` (`ast.test.ts`, `gate.test.ts`, `score.test.ts`). `apps/control`, `apps/orchestator`, `apps/backend`, and `apps/serve` have zero test coverage — despite being where the concurrency- and security-shaped risk in this codebase actually concentrates. The race in §1 above is exactly the kind of bug a targeted concurrency test would have caught before it shipped.

**Fix — priority order:**

1. **`resolveSafePath` / `assertSafeProjectId`** (`apps/control/src/agent/tool/security.ts`, `packages/types/index.ts`) — these are load-bearing for the entire filesystem sandbox model and currently have no tests proving the traversal/symlink-escape cases they claim to handle. Write tests for: `../` traversal attempts, absolute path escapes, symlink-based escapes, and valid same-project paths at the boundary of what should be allowed.
2. **Orchestrator resolver correlation** (§1) — a test that fires two concurrent `waitForControl`-style calls for the same project and asserts each resolves with its own matching response, not a swapped one. Write this *as* the regression test for the §1 fix, not after.
3. **File-mutation tool safety** (`createFile`, `updateFile`, `replaceInFile` — or their spec-01 §7 replacements) — existence-check, hash-mismatch, and match-count behavior, including the specific case that's live-broken today: `replaceInFile` against a string with multiple occurrences should not silently report `changes: 1`.
4. **Redis redelivery** (§2) — a test that a handler throwing leaves the message claimable by `XAUTOCLAIM` after the idle threshold, and that a message exceeding the retry bound lands in the dead-letter stream.

Coverage doesn't need to be comprehensive across the whole repo to be worth doing — these four areas specifically are where an untested regression is most likely to be silent, hard to reproduce, and expensive to debug after the fact (which is exactly how §1 and the `replaceInFile` bug were found: by reading the code, not by a test failing).

---

## 4. Minor Cleanup (low priority, opportunistic)

These are not worth a dedicated pass — fix them if you're already touching the relevant file for §1–§3, otherwise leave them.

- Factor the duplicated "extract JSON from an LLM text response" logic (currently hand-rolled separately in `plannerPrompt.ts`'s initial + retry paths and again in `userGivenPromptChecker.ts`) into one shared helper. Spec 1 §4 already recommends structured/function-calling output as the real long-term fix, which would remove the need for this parsing layer entirely — this cleanup is only worth doing if that's not landing soon.
- The `orchestator`/`orchestrator` naming inconsistency (missing "r," baked into the directory name and every stream constant, e.g. `OrchestatorToBackend`) is consistent throughout the codebase, not sporadic. Not worth a rename — it'd be a large, mechanical, high-diff-noise change for zero functional benefit. Just worth a one-line note somewhere a new contributor searching for "orchestrator" will find it.

---

## 5. Acceptance Criteria

- Concurrent Build/Prompt/Run requests for the same project each resolve with their own correct response, verified by a test.
- A handler failure in `shared-redis`'s `readGroupLoop` results in the message eventually being retried (via `XAUTOCLAIM`) or dead-lettered, not silently stuck forever.
- PEL depth is observable (metric or log) per stream.
- `resolveSafePath`/`assertSafeProjectId` have tests covering traversal and symlink-escape attempts.
- The `replaceInFile` multi-match bug (or its spec-01 §7 replacement) has a regression test.

---

## 6. Non-Goals

```text
Full test coverage of the entire repository
Migrating off Redis streams to a different queue technology
Distributed orchestration redesign
Renaming "orchestator" throughout the codebase
```
