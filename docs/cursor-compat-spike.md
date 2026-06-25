# Cursor compat spike (P6-E1)

Investigation for Phase 6 Cursor bridge design. Sources: repo `hooks/hooks.json` + hook scripts, [Cursor Hooks](https://cursor.com/docs/hooks), [Third Party Hooks](https://cursor.com/docs/reference/third-party-hooks), [Claude Code Hooks reference](https://code.claude.com/docs/en/hooks), Cursor community forum reports (CLI/cloud gaps, Jun 2026).

**Task:** validate whether Zonoid's Claude hook bundle can run through Cursor's third-party `.claude/settings.json` layer, document payload deltas, TodoWrite observability, IDE vs CLI coverage, and recommendations for **H1** (gate bridge) and **H2** (todo adoption minting).

---

## 1. Third-party `.claude/settings.json` compatibility

### What Cursor maps (works)

| Zonoid hook (Claude) | Cursor event | Status |
|---|---|---|
| `SessionStart` | `sessionStart` | Mapped |
| `UserPromptSubmit` | `beforeSubmitPrompt` | Mapped |
| `SubagentStop` | `subagentStop` | Mapped |
| `PreToolUse` | `preToolUse` | Mapped |
| `PostToolUse` | `postToolUse` | Mapped |
| `PreToolUse(*)` orch-stop | `preToolUse` + `*` matcher | Mapped |
| Exit code 2 blocking | Same | Mapped |
| `hookSpecificOutput` (nested) | Supported + flat `permission`/`additional_context` | Mapped |
| `timeout` on command hooks | Supported | Mapped |

**Prerequisites:** Cursor Settings → Features → **Third-party skills** enabled. Hooks load from `.claude/settings.json`, `.claude/settings.local.json`, or `~/.claude/settings.json` (priority below native `.cursor/hooks.json`).

**Response format:** Zonoid scripts emit Claude-style `hookSpecificOutput`. Cursor docs accept nested and flat formats.

### What breaks or needs adapter work

| Issue | Detail | Affected Zonoid hooks |
|---|---|---|
| **Session correlation** | Claude uses `session_id`. Cursor native uses **`conversation_id`** (+ `generation_id`). Third-party docs do not promise `session_id` on tool hooks. Scripts use `jq -r '.session_id // empty'` and **fail open when empty** (gate off). | All session-aware hooks |
| **`Edit` matcher** | Cursor maps Claude `Edit` → `Write`. Native matchers should use **`Write`**. | `orch-gate.sh` |
| **`Bash` vs `Shell`** | Claude `Bash` → Cursor `Shell`. `orch-gate-bash.sh` not in plugin `hooks/hooks.json`. | Bash write bypass |
| **`TaskCreate` / `Agent`** | No Cursor equivalents. Use **`TodoWrite`** + **`Task`**. | `suggest-links.sh`, `post-agent.sh` |
| **`SubagentStart`** | Cursor-only hook; different payload fields vs Claude `subagent-start.sh`. | `subagent-start.sh` |
| **Double execution** | Both `.cursor/hooks.json` and `.claude/settings.json` can fire. | All |
| **Stale comment** | `suggest-links.sh` says desktop does not run hooks — wrong for Cursor IDE. | Docs only |

**Verdict:** Third-party layer works as **first pass** after `session_id // .conversation_id` normalization and matcher updates; native `.cursor/hooks.json` needed for `subagentStart` and shell gate.

---

## 2. Payload field differences (Claude vs Cursor)

### Session / identity

| Field | Claude | Cursor | Zonoid today |
|---|---|---|---|
| Session | `session_id` | `conversation_id` | `.session_id` only |
| Transcript | `transcript_path` | `transcript_path` | OK |
| Workspace | `cwd` | `workspace_roots[]`, `CURSOR_PROJECT_DIR` | `.cwd` in SessionStart |

```bash
SID=$(printf '%s' "$INPUT" | jq -r '.session_id // .conversation_id // empty')
```

### Tool hooks

| Field | Claude | Cursor |
|---|---|---|
| Tool name | `tool_name` | `tool_name` (values differ) |
| Input | `tool_input` | `tool_input` |
| Post output | `tool_response` | `tool_output` (JSON string) |

### Tool name mapping (Cursor third-party table)

| Claude | Cursor |
|---|---|
| `Bash` | `Shell` |
| `Edit` | `Write` |
| `TaskCreate` | — (use `TodoWrite`) |
| `Agent` | — (use `Task`) |
| `Glob` / `WebFetch` / `WebSearch` | — |

`orch-gate.sh` already reads `new_string // content` — OK for Cursor Write.

---

## 3. TodoWrite in preToolUse / postToolUse

- Cursor docs list matchers: `Shell`, `Read`, `Write`, `Grep`, `Delete`, `Task`, MCP — **`TodoWrite` not listed**.
- Claude Code: `TodoWrite` matcher works (community-verified, undocumented).
- Cursor exposes `TodoWrite` to agents; hook wiring **unconfirmed**.
- Forum: `AskQuestion` skips pre/post hooks — not all tools wired.

**Expected payload if wired:**

```json
{
  "tool_name": "TodoWrite",
  "tool_input": {
    "todos": [{ "id": "...", "content": "...", "status": "pending" }],
    "merge": true
  }
}
```

No `blockedBy` field — deps via `add_dependency` after mint.

| Check | Result |
|---|---|
| Cursor docs confirm TodoWrite matcher | **No** |
| Repo hook capture | **No** (H2 must spike live) |
| Safe to assume for H2 | **No** — hypothesis only |

**Fallbacks:** `postToolUse` matcher `*` + filter; native `.cursor/hooks.json`; stub-folder shell watch.

---

## 4. IDE vs CLI hook coverage gaps

| Hook | IDE | CLI headless | Cloud agent |
|---|---|---|---|
| pre/post ToolUse | Yes | Yes | Yes |
| beforeShellExecution | Yes | Yes | Yes |
| sessionStart / beforeSubmitPrompt / stop | Yes | Interactive only | **No** |
| afterAgentResponse | Yes | **Broken** | **Not wired** |
| User `~/.cursor/hooks.json` | Yes | Yes | **No** |
| Third-party `.claude/settings.json` | Yes (toggle) | Unknown | Unknown |

**Zonoid impact:** classify/stop/session register degrade in CLI `-p` and cloud; write gate + postToolUse mostly OK; MCP/daemon refusal remains backstop (Phase 3).

---

## 5. Recommendations

### H1 — gate bridge

1. `zonoid init --harness cursor` → `.claude/settings.json` + enable Third-party skills.
2. Shared normalizer: `session_id // conversation_id`, workspace from `workspace_roots[0]`.
3. Native `.cursor/hooks.json` for: `subagentStart`, `beforeShellExecution` (bash gate), optional `beforeMCPExecution`.
4. Matchers: `Write` not `Edit|Write`; `Task` not `Agent|Task`; `beforeSubmitPrompt` not `UserPromptSubmit`.
5. Avoid dual hook configs without dedup.
6. Register `claimSessions` with `conversation_id` on `start_task`.

### H2 — todo minting

1. **Blocking spike:** `.cursor/hooks.json` postToolUse matcher `TodoWrite` + `scratch/cursor-hook-capture.sh`.
2. Mint stub files `cursor/<id>.json` → `POST /sync` → quarantine inject (reuse suggest-links text).
3. Wire deps with `add_dependency` only.
4. Do not ship until live hook capture confirms `tool_name` and `todos[]`.

---

## Appendix — References

- `hooks/hooks.json`, `docs/multi-harness-plan.md` Phase 6
- https://cursor.com/docs/hooks
- https://cursor.com/docs/reference/third-party-hooks
- https://code.claude.com/docs/en/hooks

*Spike 2026-06-12, worker-e1. TodoWrite capture deferred to H2.*

