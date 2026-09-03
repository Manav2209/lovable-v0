# Spec 1 — Old Agent → ReAct Agent

**Status:** Proposed
**Scope:** `apps/control` (agent, tools, workflow)
**Repository:** `Manav2209/lovable-v0`
**Related specs:** [`spec-04-data-durability.md`](./spec-04-data-durability.md) (workspace persistence hook), [`spec-05-security-hardening.md`](./spec-05-security-hardening.md) (tool surface hardening), [`spec-02-evals.md`](./spec-02-evals.md) (consumes this stage's output contract)

This is Stage 1 of the original three-stage plan, revised after a full code review of the current implementation. Content unchanged from the original where the diagnosis held up under review; adjusted where the review found a reason to reorder or extend it. Those adjustments are marked **[REVIEW]**.

---

## 1. Architectural Principle

> **The LLM decides what code should change; deterministic infrastructure decides whether changes are safe and valid.**

```text
LLM
 ├── understand the request
 ├── inspect the repository
 ├── choose the next action
 └── decide how to modify the code

Deterministic infrastructure
 ├── enforce tool permissions
 ├── enforce filesystem safety
 ├── validate builds
 ├── provide diagnostics
 └── enforce runtime limits
```

The migration is not "swap one workflow library for another." It changes who controls the coding process:

```text
OLD                                      NEW
Workflow controls coding decisions.      Agent controls coding decisions.
                                          Workflow/infrastructure controls
                                          safety and validation.
```

---

## 2. Current Architecture (verified against `apps/control/src`)

```text
User Prompt
    ↓
Security Checker      (userGivenPromptChecker.ts — currently fails OPEN on parse error, see spec-05 §2)
    ↓
getContext
    ↓
Smart Analyzer
    ↓
Prompt Enhancer
    ↓
Planner                (plannerPrompt.ts — emits a full toolCalls[] array via regex-extracted JSON)
    ↓
toolCalls[]
    ↓
Tool Executor          (executes the array blindly, no re-inspection between calls)
    ↓
stitchApp               (stitchApp.ts — unconditional full App.tsx regeneration, runs every fix-loop pass)
    ↓
Build / Validate
    ↓
Repair
```

Confirmed problems with this shape:

- **The planner creates a predetermined execution program.** `plannerPrompt.ts` produces a complete `toolCalls[]` sequence up front; the executor runs it without re-checking repository state between steps. If reality diverges from what the planner assumed (a file already exists, a component was renamed, a previous step failed silently), later steps in the array execute against stale assumptions anyway.
- **Workspace identity is implicit global state.** `workflow.ts` sets `process.env.PROJECT_ID = state.projectId` inside `executeNode`, and every tool reads it back out via `getProjectDir()` in `security.ts`. This works today only because each control pod happens to handle exactly one project — it is not an enforced invariant.
- **`stitchApp` is a blunt, destructive fallback that runs in the happy path.** It fully regenerates `App.tsx` from a naive component-name heuristic (`.includes(name)` substring matching — both false-positive and false-negative prone) on *every* iteration of the fix loop, not just once after initial generation. It can silently discard a correct, custom `App.tsx` (routing, providers, layout) that a later repair step produced.
- **File-mutation tools have no safety rails.** `createFile` silently overwrites; `updateFile` has no concurrency check; `replaceInFile` uses `String.replace()` (first-match-only) but reports `changes: 1` unconditionally, regardless of how many matches actually existed.

---

## 3. Target Architecture

```text
User Prompt
    ↓
Security
    ↓
Template Facts
    ↓
Repository Retrieval
    ↓
Short Plan
    ↓
┌──────────────────────────────┐
│       ReAct Agent Loop       │
│                              │
│  Inspect → Decide → Edit     │
│      → Observe → Repeat      │
└──────────────────────────────┘
    ↓
Build Gate
    ↓
   ┌───────────────┐
   │ Build passes? │
   └───────┬───────┘
       yes │ no
           │
           ↓
     Minimal Repair
           ↓
        Validate
           ↓
       Run Preview
```

The ReAct loop — inspect, decide, edit, observe, repeat, driven by actual tool observations rather than a pre-committed plan — is the core change.

---

## 4. Stage 1.1 — Replace Executable Planner Output

**Current:** the planner returns tool names, arguments, and an execution order.

**New:** the planner returns only intent.

```ts
type AgentPlan = {
  objective: string;
  areas: string[];
  constraints: string[];
  steps: string[];
};
```

```json
{
  "objective": "Build a dashboard with reusable cards and a sidebar",
  "areas": ["src/App.tsx", "src/components", "src/pages"],
  "constraints": [
    "Use existing shadcn components where possible",
    "Preserve existing routing"
  ],
  "steps": [
    "Inspect the application structure",
    "Implement the dashboard UI",
    "Integrate the dashboard into the application",
    "Validate the build"
  ]
}
```

The planner must **not** generate: tool names, tool arguments, file contents, or exact command sequences.

**[REVIEW]** The current planner's JSON extraction (`plannerPrompt.ts`) hand-rolls regex-based code-fence/brace parsing, duplicated near-verbatim for its retry path, and the same logic is duplicated again in the security checker. When rebuilding this as intent-only output, factor the JSON extraction into one shared helper rather than carrying the duplication forward — or better, use the model provider's native structured-output mode so this parsing layer isn't needed at all.

---

## 5. Stage 1.2 — Add `AgentRuntime` **(moved up — see rationale below)**

**[REVIEW] Sequencing change from the original plan:** the original implementation order placed `AgentRuntime` near the end of Stage 1 (after retrieval tools, mutation tools, and the ReAct loop were already built). Every one of those tools currently depends on `getProjectDir()` reading `process.env.PROJECT_ID`. Building the new tool surface against that global first and re-plumbing it afterward means touching every tool file twice. Do this step first instead, and write every new tool against the final interface from the start.

```ts
type AgentRuntime = {
  projectId: string;
  projectDir: string;
  abortSignal: AbortSignal;
};
```

Tools receive runtime explicitly:

```ts
tool.execute(args, runtime)
```

Avoid request-scoped workspace identity through global process state such as `process.env.PROJECT_ID`.

---

## 6. Stage 1.3 — Build the ReAct Loop

Use native LangChain tool calling:

```ts
const messages = [systemPrompt, userPrompt, plan];

for (let step = 0; step < MAX_AGENT_STEPS; step++) {
  const response = await modelWithTools.invoke(messages);

  if (!response.tool_calls?.length) {
    return response;
  }

  for (const call of response.tool_calls) {
    const result = await executeTool(call, runtime); // AgentRuntime from §5

    messages.push(response);
    messages.push(toToolMessage(call, result));
  }
}
```

```text
LLM → read/search → observation → LLM → edit → observation → LLM → more inspection/editing → ...
```

The next action must be based on actual tool observations, not a pre-committed step list.

---

## 7. Stage 1.4 — TemplateFacts

Make the React/Vite template the source of truth.

```ts
type TemplateFacts = {
  framework: "react";
  buildTool: "vite";
  language: "typescript";
  styling: "tailwind";
  componentLibrary: "shadcn";
  packageManager: "bun";

  entryPoints: { main: string; app: string };

  directories: {
    components: string;
    pages?: string;
    hooks?: string;
    lib?: string;
  };
};
```

The template should be represented accurately — React, Vite, TypeScript, Tailwind, shadcn, Bun, `src/main.tsx`, `src/App.tsx`. Remove contradictory assumptions such as `App.jsx`.

**[REVIEW]** Derive `TemplateFacts` from **the template as actually pulled from R2** (`pullTemplatefromR2`), not from the copy of `apps/template` in this repo. `decision.md`'s own open follow-ups note the R2-hosted template may still be missing fixes (e.g. a `start` script) that the local copy already has. If `TemplateFacts` hardcodes an assumption that doesn't match what a new project actually receives, this reproduces the exact "prompt assumptions vs. reality" failure this stage exists to eliminate — just one layer up. Verify the two are in sync (or generate `TemplateFacts` by inspecting the pulled template at runtime) before treating it as static config.

---

## 8. Stage 1.5 — Repository Retrieval

The agent retrieves repository information incrementally.

Initial tools: `listFiles`, `searchFiles`, `readFile`.

```text
User: "Add a settings page."

Agent: searchFiles("router")
Agent: readFile("src/App.tsx"); readFile("src/main.tsx")
Agent: inspect relevant routing/components
Agent: create/update required files
```

Do not send the entire repository to the model.

**Vector database:** do not introduce one during this migration. Start with `file tree + search + targeted reads`. AST/import/symbol indexes are a future improvement, justified only by evaluation data (see Non-Goals).

---

## 9. Stage 1.6 — Coding Agent Tool Surface

Initial tools:

```text
listFiles
searchFiles
readFile

createFile
updateFile
patchFile
deleteFile

addDependency
addShadcnComponent
```

**[REVIEW]** The current `executeCommand` tool (`apps/control/src/agent/tool/simple/executeCommand.ts`) runs arbitrary LLM-generated shell strings with `shell: true` — only the working directory is sandboxed, not the command content. Rebuilding the tool surface is the point at which this gets **removed**, not just avoided for new tools going forward — a generic shell-execution tool left available alongside the new surface gives the ReAct agent the same escape hatch the old planner had. Full hardening detail (allowlisted equivalents, what stays vs. goes) is in [`spec-05-security-hardening.md`](./spec-05-security-hardening.md) §3 — do that removal as part of this stage's tool-surface work, not as a follow-up.

---

## 10. Stage 1.7 — Safe Filesystem Mutations

**`createFile`:** file exists → fail. File missing → create. Do not silently overwrite.

**`updateFile`:** optimistic concurrency.

```ts
updateFile({ path, content, expectedHash });
```

Reject when the current file hash differs from `expectedHash`.

**`replace`/`patch`:**

```text
0 matches → fail
1 match   → replace
>1 matches → fail unless replaceAll=true
```

**[REVIEW]** This directly fixes a live bug in the current `replaceInFile.ts`, which uses plain-string `.replace()` (first-occurrence-only) but reports `changes: 1` regardless of actual match count — not just a missing safety net, an incorrect result today.

**Multi-file writes:** reduce partial-write risk through staged or transaction-like behavior where practical.

**[REVIEW] Persistence hook:** each successful mutation should report `changedFiles` (see §14 `ToolResult`). This is the natural place to call the workspace-persistence hook defined in [`spec-04-data-durability.md`](./spec-04-data-durability.md) — either after each successful build, or debounced per batch of mutations. Don't defer this to a later pass; the mutation path is being rewritten here regardless, and today there is *no* code path that persists generated work durably.

---

## 11. Stage 1.8 — Inspect Before Edit

```text
readFile → content + hash → agent decision → updateFile(expectedHash)
```

This prevents stale-context overwrites.

---

## 12. Stage 1.9 — Remove `stitchApp` From Happy Path

**Current:** generate files → `stitchApp` → rewrite `App.tsx` (unconditionally, every fix-loop pass).

**Target:**

```text
Agent → inspect App.tsx → inspect routing → create/update files → integrate directly → build
```

`stitchApp` may temporarily remain as a recovery/compatibility path during migration — invoked explicitly as a fallback, not run automatically on every iteration. It should not be required for normal successful generations.

---

## 13. Stage 1.10 — Build Gate, Minimal Repair, Runtime Limits

**Build Gate:** deterministic, single validation build after the agent completes its coding work. Avoid duplicate build/install work spread across multiple workflow nodes.

```text
ReAct Agent → Build → PASS / FAIL
```

**Minimal Repair:** on failure, diagnose → identify affected files → repair agent (inspect, minimal fix) → build again. Do not regenerate the entire application. Repair receives `build error + relevant files + relevant source context`, within a bounded repair budget.

**Runtime Limits:** the ReAct loop needs `MAX_AGENT_STEPS`, `MAX_TOOL_CALLS`, `MAX_RUNTIME`, and an `AbortSignal`. Add stall detection for repeated `same tool + same arguments + same workspace state`.

---

## 14. Stage 1.11 — Standard Tool Results

```ts
type ToolResult = {
  success: boolean;
  message: string;
  data?: unknown;
  diagnostics?: { path?: string; line?: number; column?: number };
  changedFiles?: string[];
};
```

This becomes the observation contract for the ReAct loop, and the trigger point for the persistence hook noted in §10.

---

## 15. Stage 1 Acceptance Criteria

- Planner no longer emits executable `toolCalls[]`.
- ReAct loop dynamically chooses tool calls.
- Agent can inspect repository state before editing.
- `AgentRuntime` is explicit and threaded through every tool from the start (not retrofitted).
- `TemplateFacts` are verified against the actual R2-pulled template, not just the local repo copy.
- File mutation safety rules are enforced (existence check, hash check, match-count check).
- `executeCommand`'s unrestricted shell form is removed from the tool surface (see spec-05 §3).
- `stitchApp` is not required in the happy path.
- Build is a single deterministic validation gate.
- Repair is diagnostic-driven and bounded.
- Step/tool/time limits are enforced.
- Successful mutations report `changedFiles` and invoke the persistence hook (spec-04).
- Existing basic generation behavior still works.

At this point, stop and validate the agent manually before changing the eval architecture (Spec 2).

---

## 16. Implementation Order **(revised)**

```text
1.  Freeze OLD agent baseline
2.  Add AgentRuntime                         [REVIEW: moved up from #10]
3.  Replace planner toolCalls[] model
4.  Implement ReAct loop
5.  Add TemplateFacts (verified against R2)
6.  Add retrieval tools (built against AgentRuntime)
7.  Harden file mutation + wire persistence hook (spec-04)
8.  Finalize tool surface — remove executeCommand (spec-05 §3)
9.  Remove stitchApp from happy path
10. Separate build gate
11. Add repair loop
12. Add limits
13. Validate NEW agent manually
```

---

## 17. Non-Goals

```text
Vector database
Multi-agent architecture
Distributed orchestration redesign
Ingress redesign          — tracked separately, spec-05
Kubernetes redesign
Persistent agent memory
Major backend event-correlation redesign  — tracked separately, spec-06
Advanced repository semantic indexing
```

These should only be reconsidered when actual agent/eval data demonstrates a need.
