# Eval baselines

Freeze a run of the **previous** agent (or any named snapshot) so OLD vs NEW comparison is possible after the ReAct migration.

```bash
# After a complete eval run:
bun run eval --save-baseline legacy

# Compare two run folders (also works for baselines/ vs runs/):
bun run eval --before baselines/legacy --after runs/run_xxxx
```

The planner-era agent is no longer in tree; store the last green `runs/run_*` directory from before spec-01 as `baselines/legacy` if you still have it.
