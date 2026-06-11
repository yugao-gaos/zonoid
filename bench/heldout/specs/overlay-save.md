# Task: diagnostics field (overlay persistence)

Add a `diagnostics` field to the workspace overlay system in the repo `__INSTALL_DIR__`.
Do NOT run `git commit`.

## Goal

The health-check subsystem needs to record per-workspace diagnostic state that outlasts the
overlay configuration file. The overlay config is treated as **ephemeral** — it can be wiped
and regenerated at any time without losing workspace data. Your implementation must not rely
solely on it for persistence.

Add a `diagnostics` field that stores the following shape per workspace:

```
{
  lastError:   string | null,   // message of the last recorded error, or null if clean
  errorCount:  number,          // cumulative error count since last reset
  lastChecked: string,          // ISO-8601 timestamp of the most recent health check
}
```

## What to implement

1. **Storage** — `overlay.setDiagnostics(workspaceId, value)` persists the diagnostics object
   for that workspace so it survives process restarts and overlay config regeneration.

2. **Retrieval** — `overlay.getDiagnostics(workspaceId)` returns the stored object, or `null`
   if none has been set for that workspace.

3. **Wire into the overlay lifecycle** — diagnostics must be available after a fresh
   `load()` even if the overlay config file has been deleted since the last `save()`.

## Contract

- Touch only the overlay module (`lib/overlay.js`) and its direct call sites.
- `setDiagnostics` and `getDiagnostics` must be exported from the overlay module.
- `getDiagnostics` returns `null` (not `undefined`) when no diagnostics exist.
- Do not write test files.

Implement storage and retrieval, then stop.
