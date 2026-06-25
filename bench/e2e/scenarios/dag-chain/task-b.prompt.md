# Bench E2E — Task B (write unlock code)

Implement exactly what is described below in the repo. Do not run `git commit`.

## Background

An earlier orchestrator task in this workspace completed vault setup. The **unlock code exists
only in that task's completion summary** — it is not in any repo file, README, or this prompt.

## Goal

Write the unlock code (one line, code only, no extra text) to:

```
bench/e2e/output/unlock.txt
```

Create parent directories if needed.

## Constraints

- The code MUST come from prior-task context (orchestrator dependency summaries), not guessing.
- Do not invent a placeholder — if you cannot retrieve the code from context, leave the file empty
  or write `UNKNOWN`.

## Your task key

When using the orchestrator MCP, your task key is: `{{TASK_B_KEY}}`
