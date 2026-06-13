# Multi-harness portability plan

Status: agreed 2026-06-12 · branch `feat/harness-adapters` · Phase 1 landed (`a5e2166`)

## Architecture

One harness-agnostic core — daemon, graph store, overlay, context gate, judge, dashboard,
MCP surface. Per-harness **adapters** with two halves:

- **Bridge** — how the harness's *guaranteed* mechanisms (hooks / plugins) call the daemon
  and relay its verdicts (context injection, deny-with-reason) in the harness's dialect.
- **Data sync** — only where it earns its keep. Today: Claude task adoption + transcripts.
  No syncing of other harnesses' internal todo stores.

Enforcement lives in exactly two places:

1. Harness-guaranteed hooks (Claude, Cursor; Codex partially; OpenCode plugins).
   Hooks are enforced by the harness — the agent cannot skip them.
2. Daemon-side refusal for operations the daemon itself mediates (claims, merges,
   metric-branch invariant). The only guaranteed chokepoint on a pure-MCP path.

MCP is the agent-facing cooperative surface. Calls are not reliable and never load-bearing
for enforcement. **The shared/default MCP tool list does not change.**

## Task identity & storage (the core decision)

One authoritative task store in the daemon. Tasks are minted per-harness in the harness's
native idiom; the daemon **adopts the stub at birth** (id, title, blockedBy — the only
native fields with real value) and is authoritative from that moment. The overlay carries
everything real (claims, summaries, knowledge, metrics, provenance, edges).

- **Substrate:** one daemon route `POST /task/create` shared by every minting path.
  Response: `task_key` + inline link suggestions (the suggest-links nudge, in-band)
  + provenance stamp `created_by: { harness, agent_id }`.
- **No public `create_task` MCP tool in the default surface.** Tool exposure is an
  adapter decision (see per-harness minting below).
- **Claude:** native `TaskCreate` stays the entry point forever. Adoption at first sight
  replaces snapshot-at-terminal-status; aggregation precedence flips (adopted node
  authoritative; native file = live echo while it exists — status/title changes fold in,
  todo-panel write-through preserved, retention-sweep GC harmless).
- **Local namespace:** non-native tasks live under `local/<id>`; never collides with
  Claude's `<session>/<id>`; `writeStatus` write-through cleanly no-ops for `local/` keys.

### Per-harness task minting

| Harness  | Minting path | Notes |
|---|---|---|
| Claude   | native `TaskCreate` → hook → adoption | unchanged, reference pattern |
| Cursor   | native todo tool → `postToolUse` hook → adoption | mirrors Claude; verify todo tool matchability in hook payloads; no `blockedBy` → wire deps via existing `add_dependency` |
| OpenCode | plugin-registered custom `task_create` tool → `POST /task/create` | native-feeling, cleanest |
| Codex    | harness-scoped MCP tool list: stdio server advertises `create_task` only in Codex wiring | fallback; test whether plan-tool fires hooks (speculative) |

## Phases

**Phase 1 — Seam extraction. DONE** (`a5e2166`, 64/64 green).
`lib/harness.js` registry + `lib/adapters/claude.js` thin delegation; Claude modules untouched.

**Phase 2 — Task identity & storage unification.**
- Adopt-on-first-sight for native tasks; precedence flip; snapshot-at-terminal machinery
  dissolves into adoption.
- `POST /task/create` route (no MCP tool): key minting, provenance, inline suggestions.
- Durability: nodes survive daemon restart and native-file GC. No key-format change;
  existing graphs keep working.
- Acceptance: suite green; Claude flow byte-identical when no `local/` tasks exist.

**Phase 3 — MCP self-sufficiency (hookless lifecycle).**
- `start_task` auto-registers unknown agents; every `agent_id`-carrying call stamps
  `lastSeen` (prevents false stale-sweeps of silent foreign workers).
- `complete_task` response carries `newly_ready`; responses carry `should_stop` advisories.
- Metric-branch invariant enforced at claim time in the daemon (`start_task` refuses
  without an attempt worktree). Hook check stays as defense-in-depth.
- Idempotent alongside hooks (double-registration safe).

**Phase 4 — Thin-adapter prep: daemon absorbs script logic.**
- `/classify` endpoint absorbs `classify.sh` script-resident heuristics (solo/workflow/
  team/loop signals, model selection, ready-flag caching); returns finished injection text.
- Claude scripts slim to dumb relays; observable behavior byte-identical.
- Adapter contract doc: daemon endpoints (`/workspace`, `/active-claim`, `/should-stop`,
  `/agent/start|done`, `/classify`, `/ready`, `/task/create`) ARE the contract; canonical
  event table mapping each to Claude/Cursor/Codex/OpenCode mechanisms.

**Phase 5 — Usage sources.**
- Adapter-provided transcript readers (Claude unchanged; Cursor JSONL transcripts get a
  reader); self-reported fallback elsewhere. Cost attribution degrades gracefully.

**Phase 6 — First bridge: Cursor.**
- Try the zero-cost path first: Cursor reads `.claude/settings.json` hooks natively
  (auto-mapped events, exit-2 blocking, `hookSpecificOutput`). Validate payload mapping —
  session-id correlation is the expected friction. Native `.cursor/hooks.json` variant
  where needed. Todo-adoption minting (above). Document IDE-vs-CLI hook coverage.
- Cursor gets the hard write gate (same trust level as Claude).

**Phase 7 — Codex + OpenCode bridges.**
- Codex: `hooks.json` / `[hooks]` in `config.toml`, Claude-style schema. Mind: unsupported
  `PreToolUse` fields fail closed; manual trust on definition-hash change; not every shell
  path intercepted. Harness-scoped `create_task` exposure.
- OpenCode: plugin — throw-to-block in `tool.execute.before` (never rely on arg rewriting:
  known frozen-args/propagation bugs), `event` subscription for lifecycle, custom
  `task_create` tool registration.

**Phase 8 — Installer & lifecycle.**
- `zonoid init --harness claude|cursor|codex|opencode` (default `claude`, unchanged).
- IDE setups default to stdio MCP transport (self-boots the daemon per tool call already).
- launchd/systemd service option for always-on daemon where HTTP connectors are used.

## Frozen / non-goals

- `hooks/*.sh` behavior, Claude task flow + todo UI, existing MCP tool signatures,
  on-disk graph formats: unchanged.
- No MCP access restriction (daemon-side invariants instead). No auth until the daemon is
  exposed beyond localhost (then: one bearer token across ALL routes, HTTP + MCP alike).
- No syncing other harnesses' internal todo stores.
- No UX assumptions about any harness: in-band tool responses + browser dashboard only.

## Mechanics

All work on `feat/harness-adapters`; one phase per dispatched worker; full suite green per
phase; workers stage in `/tmp` clones (gate-exempt) and the dispatcher fast-forwards.
Critical path: 2 → 3; 4 and 5 are independent after 2; 6 needs 2–4; 7–8 trail.

## Key reasoning (for future readers)

- Native task files were never a data store — they are an **identity mint + frictionless
  creation ritual** (the seamlessness IS the feature). Hence: adopt the ID at birth,
  replicate the handshake per harness, never mirror whole stores.
- The hook layer is thin by design: hooks curl the daemon and relay verdicts (context
  injection or exit-2 deny whose message contains the corrective MCP recipe). Keeping it
  thin is what makes per-harness bridges a few dozen lines of glue.
- Cursor/Codex/OpenCode all expose usable adapter surfaces (verified Jun 2026; see
  knowledge note "harness hook capability matrix").
