# Batch C tranche-1 baseline

Frozen results for the **first eval sweep of the post-refactor ReAct agent** (Batch A/B/C
commits merged on `main`). Model: `airouter/openai/gpt-4o-mini` (match with the earlier
`counter-basic` 95/100 run for comparability).

## Cases (8)

| Case | Tier | Status | Score | Notes |
| --- | --- | --- | --- | --- |
| counter-basic | easy | completed | 97 | features 3/3, judge 100 |
| todo-basic | easy | completed | 98 | features 5/5, judge 100 |
| landing-page | easy | completed | 97 | features 5/5, judge 98 |
| add-component-using-existing-library | easy | completed | 99 | features 3/3, judge 100 |
| modify-existing-component | easy | completed | 98 | features 3/3, judge 100 |
| edit-existing-app | medium | completed | 100 | features 4/4, judge 93 |
| add-page-to-existing-router | medium | completed | 100 | features 4/4, judge 100 |
| preserve-existing-functionality | medium | **timeout** | 32 | **known failure**, see below |

## Known failure: preserve-existing-functionality

Reproducible across two runs (run_mtvm8qb6 aborted mid-repair, run_mtwbg7q7 timed out at
600s). The agent **hand-writes** `src/components/ui/checkbox.jsx` importing
`{ Checkbox } from 'shadcn/ui'` and registers it in `ui/index.js`, then tries
`addDependency @radix-ui/react-checkbox`, `@shadcn/ui`, `shadcn/ui` — none of which
resolve (`Missing "./ui" specifier in "shadcn" package`; template components import
`radix-ui` directly). Repair loop never recovers because the model keeps re-creating the
same non-resolving import. Correct behavior is `<input type="checkbox">` with
`onChange` + strikethrough via `task.completed`.

**Fix direction (future batch):** harden `addShadcnComponent`/prompt guidance so the
model uses radix-ui pattern from `apps/template` and does not fabricate `shadcn/ui` /
`@shadcn/ui` imports; or normalize `addDependency` to reject suspicious package names.
Filed as a known agent defect, not blocking the tranche-1 gate for other cases.

## ReAct aggregates

tools/success ≈ 7.2 (easy 5), builds/case = 1.0, repairRate = 0%. No stalls
(`Agent stalled`), no context-eviction artifacts on landing-page (large prompt).

## Gate

`apps/evals/baselines/gates/tranche1.json` → run `bun run ./src/index.ts --gate ../baselines/gates/tranche1.json`.