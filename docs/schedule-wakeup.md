# ScheduleWakeup

Short reference for session-scoped delayed re-prompts (heartbeat / idle polling). Full adapter
mapping: [adapter-contract.md](./adapter-contract.md#scheduler-contract-schedulewakeup).

## Contract

```
ScheduleWakeup(delaySeconds, reason, prompt)
```

- **Cancel + arm:** each call kills any prior wake for the session, then starts one new timer.
- **Fire line:** after `delaySeconds`, append to `<runtime-data-dir>/wake/<session-slug>.fire`:

  ```
  ORCH_SCHEDULED_TASK {"delaySeconds":7200,"reason":"idle heartbeat","prompt":"<<autonomous-loop-dynamic>>"}
  ```

- **Monitor:** hookless clients can run the tool-returned `command` (typically
  `tail -n0 -F <fire path>`) and match stdout against `notify_pattern`
  (`^ORCH_SCHEDULED_TASK`). Codex Desktop real-session delivery is also supervised by the daemon.

## Codex Desktop sessions

Codex hooks can expose a `session_id`, but that hook process does not share request-scoped state
with the MCP subprocess. Codex `SessionStart` persists the latest real session id for the current
workspace in an adapter-owned bridge file. Codex `ScheduleWakeup` resolves the session at call time:
explicit `session_id` first, then hook/context/env ids, then the workspace bridge, and finally a
cryptographically random session key local to that MCP process. The fallback key is stable for that
process only, collision-resistant across MCP processes, and neither workspace-global nor persisted
as a cross-thread identity.

Arming a wake always guarantees timer delivery to the `.fire` file. When the resolved Codex session
is real, the daemon starts an in-process delivery supervisor at Codex `SessionStart` and again on
daemon boot for bridged workspaces. The supervisor creates the `.fire` file if needed, watches for
new `ORCH_SCHEDULED_TASK` lines, and invokes `codex resume <session-id> <prompt>`. The tool still
returns `delivery.supported: true`, `delivery.session_id`, and a `delivery.command` pipeline for
compatibility and diagnostics. When only the random fallback is available, `delivery.supported` is
`false`: the timer is armed, but there is no Codex Desktop thread identity to resume.

## Where it lives

| Layer | Path |
|---|---|
| Core substrate | `lib/schedule-wakeup.js` |
| Shell CLI | `adapters/common/schedule-wakeup.sh` (`arm` / `cancel`) |
| MCP (cursor, codex) | `lib/mcp-harness-tools.js` → tool name `ScheduleWakeup` |
| Codex delivery supervisor | `lib/codex-wakeup-delivery.js` daemon-owned watcher → `codex resume <session-id> <prompt>` |
| Codex delivery monitor CLI | `adapters/codex/wakeup-monitor.js` compatibility pipeline for manual diagnostics |
| OpenCode plugin | `packages/opencode-plugin` → tool `schedule_wakeup`; in-plugin delivery via `packages/opencode-plugin/lib/wake-delivery.js` → SDK `client.session.promptAsync` (self-driving heartbeat) |
| Adapter scheduler | `lib/adapters/scheduler-substrate.js` |
| Claude native | Built-in — no MCP duplicate |

Wake pid/fire files live under the Zonoid runtime data dir's `wake/` folder.
`ORCH_DATA` wins exactly when set; otherwise `ZONOID_DATA`, legacy
`CLAUDE_PLUGIN_DATA`, or `~/.claude/orchestrator/.zonoid` is used. Durable graph
state remains in workspace `.graph/`.

## Leak reaping (daemon sweeps)

Armed sleepers are detached `node -e` processes, so a lost fire (hard kill, crashed sleeper,
daemon restart) leaks both a live process and a dangling registry row. Two sweeps run in the
daemon's 60s cycle (`daemon.js`, inside `require.main === module`, each `setInterval(...).unref()`'d)
and both reuse the module's single `isPidAlive` / `killPid` pair — there is no second liveness or
kill path.

**Registry.** `armWakeup` records `KEY -> {pid, fireAt, session}` in
`<workspace>/.graph/scheduled-wakeups.json` (falls back to the runtime data dir when
`ORCH_WORKSPACE` is unset). The sleeper deletes its own row when it fires.

### Part 1 — `sweepStaleWakeups()` (always on)

Reconciles every registry row against process reality:

| Row state | Action |
|---|---|
| pid dead | prune the row (it fired + exited; the reap-on-fire write may have been lost) |
| pid alive, `now > fireAt + GRACE` | stuck sleeper → `killPid` + prune |
| pending, or only just past `fireAt` | leave alone |

`GRACE` defaults to **5 min**, override with `ORCH_WAKEUP_GRACE_MIN`. Rows with a non-numeric
`fireAt` are never treated as overdue — they are pruned only when their pid is dead. Returns
`{swept, killed, pruned}`.

### Part 2 — `sweepOrphanProcesses()` (opt-in, default OFF)

An OS-level janitor for leaked *node* processes generally, not just sleepers. Gated behind
`ORCH_PROCESS_JANITOR`: unset ⇒ a pure no-op returning `{enabled:false}`, having enumerated and
killed nothing. When enabled it kills only the intersection of:

1. command line matches a narrow **ephemeral allowlist** — `node --test` runners,
   `node -e "…require('./daemon')…"` blobs, and `daemon.js` launches carrying an `ORCH_*PORT=` env; and
2. age > `ORCH_PROCESS_JANITOR_MAX_MIN` (default **20 min**); and
3. pid is not protected — this daemon, plus the embed/rerank sidecars (read live from their
   pidfiles each pass, so a sidecar restart is always covered).

Anything not matching rule 1 is left strictly alone, so services, editors, shells, `mcp-graph.js`,
and the user's own node programs can never become candidates — `mcp-graph` needs no pidfile because
its argv structurally never matches. Each kill logs pid, matched pattern, and age to stderr.
Process enumeration is `ps -eo pid,etimes,args` on POSIX and `Get-CimInstance Win32_Process` on
Windows; any enumeration failure returns `[]`, so a janitor that cannot see safely does nothing.

## Heartbeat nudge (classify)

`POST /classify` injects a fixed heartbeat line into `additional_context` (see
`lib/classify-assemble.js` `HEARTBEAT`). It tells the agent to call `ScheduleWakeup` after idle
ticks; on wake, run `next_action` and reschedule only when loops still need polling.

## Init

`zonoid init --harness cursor|codex|opencode` chmods `adapters/common/schedule-wakeup.sh` and
documents the monitor workflow in CLI next-steps. OpenCode also symlinks the plugin with
`schedule_wakeup`.
