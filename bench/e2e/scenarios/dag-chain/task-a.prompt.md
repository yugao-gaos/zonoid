# Bench E2E — Task A (vault setup)

This task is run under the orchestrator in live multi-step mode. The agent completes work and
calls `complete_task` with a summary that includes the vault unlock code.

**v1 skeleton:** the runner pre-seeds Task A as `done` with the summary below instead of
running a live agent for A. Live two-step runs (A then B) are a v2 extension.

The unlock code for this scenario is: `{{SECRET}}`

When completing Task A, the summary MUST be exactly:

```
Vault unlock code: {{SECRET}}
```

Do not write the code to any file — it must exist only in the completion summary.
