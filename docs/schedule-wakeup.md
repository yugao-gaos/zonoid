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

- **Monitor:** run the tool-returned `command` (typically `tail -n0 -F <fire path>`) and match
  stdout against `notify_pattern` (`^ORCH_SCHEDULED_TASK`).

## Codex Desktop sessions

Codex hooks can expose a `session_id`, but that hook process does not share request-scoped state
with the MCP subprocess. Codex `SessionStart` persists the latest real session id for the current
workspace in an adapter-owned bridge file. Codex `ScheduleWakeup` resolves the session at call time:
explicit `session_id` first, then hook/context/env ids, then the workspace bridge, and finally a
cryptographically random session key local to that MCP process. The fallback key is stable for that
process only, collision-resistant across MCP processes, and neither workspace-global nor persisted
as a cross-thread identity.

Arming a wake always guarantees timer delivery to the `.fire` file. When the resolved Codex session
is real, the tool also returns `delivery.supported: true`, `delivery.session_id`, and a
`delivery.command` pipeline that feeds matching fire lines into `adapters/codex/wakeup-monitor.js`;
the monitor invokes `codex resume <session-id> <prompt>`. When only the random fallback is available,
`delivery.supported` is `false`: the timer is armed, but there is no Codex Desktop thread identity
to resume.

## Where it lives

| Layer | Path |
|---|---|
| Core substrate | `lib/schedule-wakeup.js` |
| Shell CLI | `adapters/common/schedule-wakeup.sh` (`arm` / `cancel`) |
| MCP (cursor, codex) | `lib/mcp-harness-tools.js` → tool name `ScheduleWakeup` |
| Codex delivery monitor | `adapters/codex/wakeup-monitor.js` → `codex resume <session-id> <prompt>` |
| OpenCode plugin | `packages/opencode-plugin` → tool `schedule_wakeup` |
| Adapter scheduler | `lib/adapters/scheduler-substrate.js` |
| Claude native | Built-in — no MCP duplicate |

Wake pid/fire files live under the Zonoid runtime data dir's `wake/` folder.
`ORCH_DATA` wins exactly when set; otherwise `ZONOID_DATA`, legacy
`CLAUDE_PLUGIN_DATA`, or `~/.claude/orchestrator/.zonoid` is used. Durable graph
state remains in workspace `.graph/`.

## Heartbeat nudge (classify)

`POST /classify` injects a fixed heartbeat line into `additional_context` (see
`lib/classify-assemble.js` `HEARTBEAT`). It tells the agent to call `ScheduleWakeup` after idle
ticks; on wake, run `next_action` and reschedule only when loops still need polling.

## Init

`zonoid init --harness cursor|codex|opencode` chmods `adapters/common/schedule-wakeup.sh` and
documents the monitor workflow in CLI next-steps. OpenCode also symlinks the plugin with
`schedule_wakeup`.
