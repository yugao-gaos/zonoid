# Cursor adapter (gate bridge)

Thin relays from Cursor hook events to the Zonoid orchestrator daemon (`http://localhost:8787`).
Shared enforcement logic stays in `hooks/` (Claude reference); this package only normalizes
Cursor payload fields and forwards.

## Prerequisites

- Zonoid installed (`zonoid init` or clone to `~/.claude/orchestrator`)
- Orchestrator MCP server configured in Cursor
- `jq` and `curl` on PATH

## Install paths

### Recommended — native `.cursor/hooks.json` (project)

1. Copy `adapters/cursor/hooks.json.sample` to your repo as `.cursor/hooks.json`.
2. Replace `__INSTALL_DIR__` with your Zonoid install path (usually `~/.claude/orchestrator`).
3. Ensure hook scripts are executable: `chmod +x adapters/cursor/*.sh` under the install dir.
4. Trust the workspace in Cursor so project hooks run.

Native hooks cover **all** H1 events including `subagentStart` (not available via third-party layer).

### Alternate — third-party `.claude/settings.json`

1. Cursor Settings → Features → enable **Third-party skills**.
2. Merge `adapters/cursor/settings.sample.json` into `.claude/settings.json` (replace `__INSTALL_DIR__`).
3. **Do not** also wire the same events in `.cursor/hooks.json` — double execution is possible.
4. Third-party layer maps Claude hook names; relays still normalize `conversation_id` → `session_id`.

`SubagentStart` is **Cursor-only** — use native `.cursor/hooks.json` for full subagent observability.

## Hook mapping

| Cursor event | Script | Daemon endpoint | Blocking |
|---|---|---|---|
| `sessionStart` | `session-start.sh` | `GET /ping`, `POST /workspace` | No |
| `preToolUse` `*` | `orch-stop.sh` | `GET /should-stop` | Yes (exit 2) |
| `preToolUse` `Write` | `orch-gate.sh` | `GET /active-claim` | Yes (exit 2) |
| `preToolUse` `Shell` | `shell-gate.sh` | `GET /active-claim` (bash writes) | Yes (exit 2) |
| `beforeShellExecution` | `before-shell-gate.sh` | same as Shell gate | Yes (exit 2) |
| `subagentStart` | `subagent-start.sh` | `POST /agent/start` | No |
| `subagentStop` | `subagent-stop.sh` | `POST /agent/done` | No |

Session correlation uses:

```bash
SID=$(jq -r '.session_id // .conversation_id // .sessionId // empty')
```

After `start_task`, register the claim with `conversation_id` via MCP or `POST /overlay/claim-session`.

## IDE vs CLI gaps (Jun 2026)

| Capability | Cursor IDE | CLI headless | Cloud agent |
|---|---|---|---|
| `preToolUse` write/shell gate | Yes | Yes | Yes |
| `beforeShellExecution` gate | Yes | Yes | Yes |
| `sessionStart` / workspace bind | Yes | Interactive only | **No** |
| `beforeSubmitPrompt` classify | Yes | Interactive only | **No** |
| `subagentStart` / `subagentStop` | Yes (native hooks) | Yes | Yes |
| User `~/.cursor/hooks.json` | Yes | Yes | **No** |
| Third-party `.claude/settings.json` | Yes (toggle) | Unknown | Unknown |

When session hooks do not fire, MCP-side refusal on `start_task` / merge remains the backstop.

## Opt out

Same as Claude: say `orch off` in chat (creates `sessions/<conversation_id>.off`), or remove hook entries.

## Related

- `docs/cursor-compat-spike.md` — payload deltas and H2 todo-minting notes
- `docs/adapter-contract.md` — daemon endpoint contract
- `hooks/` — Claude reference scripts (unchanged)
