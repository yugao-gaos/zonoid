# Multi-harness portability plan

Status: agreed 2026-06-12 · branch `feat/harness-adapters` · Phase 1 landed (`a5e2166`)

## Architecture

One harness-agnostic core — daemon, graph store, overlay, context gate, judge, dashboard,
MCP surface. Per-harness **adapters** with two halves:

- **Bridge** — how the harness's *guaranteed* mechanisms (hooks / plugins) call the daemon
  and relay its verdicts (context injection, deny-with-reason) in the harness's dialect.
- **Data sync** — only where it earns its keep. Today: Claude task adoption + transcripts.
  Other harnesses' todo stores: deferred, revisit per-harness (see non-goals).

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

- **Substrate — file-drop minting (decided 2026-06-12, supersedes the earlier
  `POST /task/create` route idea):** every adapter mimics the Claude pattern. The
  adapter writes a task JSON file into its **designated folder**; the daemon **pulls**
  (aggregation + fs.watch), exactly as it does for Claude's native files today. Writing
  a file survives daemon downtime (a failed HTTP call loses the task; a file cannot be
  lost) and decouples minting from deployment timing.
- **Documented stub format (ours, versioned — unlike Claude's internal one):**
  `{ id, subject, description, status, blockedBy, created_by: { harness, agent_id } }`.
  Atomic write convention (write `.tmp`, rename); reader skips partial/unparsable files.
- **Designated folders** live per-workspace under the daemon data dir; durable (we
  control retention), so adopt-on-first-sight remains a Claude-only need.
- **`POST /sync`:** explicit pull trigger so a creator gets immediate adoption instead of
  waiting for the watcher. Response carries adopted keys + inline link suggestions per
  new task (the suggest-links wiring nudge, in-band).
- **No public `create_task` MCP tool in the default surface.** Minting is an adapter
  concern in each harness's idiom; adapter hooks/plugins run outside the agent tool gate,
  so file minting needs no gate exemptions.
- **Claude:** native `TaskCreate` stays the entry point forever. Adoption at first sight
  replaces snapshot-at-terminal-status; aggregation precedence flips (adopted node
  authoritative; native file = live echo while it exists — status/title changes fold in,
  todo-panel write-through preserved, retention-sweep GC harmless).
- **Namespaces:** harness-prefixed keys — `cursor/<id>`, `codex/<id>`, `opencode/<id>`,
  `local/<id>` (generic) — never collide with Claude's `<session-uuid>/<id>`. The
  adapter seam's `writeStatus` generalizes per-folder (each adapter updates its own
  files; the Claude adapter keeps the todo-panel write-through).

### Per-harness task minting

| Harness  | Minting path | Notes |
|---|---|---|
| Claude   | native `TaskCreate` → file in `~/.claude/tasks` → pull | unchanged, the reference pattern |
| Cursor   | native todo tool → `postToolUse` hook writes stub file → `/sync` | verify todo tool matchability in hook payloads; no `blockedBy` → wire deps via existing `add_dependency` |
| OpenCode | plugin custom `task_create` tool writes stub file → `/sync` | native-feeling, cleanest |
| Codex    | hook or instructed shell write of stub file → `/sync` | no plugin tools; harness-scoped MCP tool remains the fallback if file path proves awkward |

## Phases

**Phase 1 — Seam extraction. DONE** (`a5e2166`, 64/64 green).
`lib/harness.js` registry + `lib/adapters/claude.js` thin delegation; Claude modules untouched.

**Phase 2 — Task identity & storage unification (file-drop substrate).**
- Generalize the pull: aggregation scans designated per-harness folders (documented stub
  format, harness-prefixed namespaces) alongside Claude's native files; per-folder watch.
- `POST /sync` endpoint: immediate pull; response = adopted keys + link suggestions.
- Adopt-on-first-sight for Claude native tasks; precedence flip; snapshot-at-terminal
  machinery dissolves into adoption.
- `writeStatus`/`snapshotNative` safe for non-session namespaces (per-folder status
  writes via the adapter seam).
- Durability: nodes survive daemon restart; native-file GC harmless. No key-format
  change; existing graphs keep working.
- Acceptance: suite green; Claude flow byte-identical when no foreign-folder tasks exist.

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
  `/agent/start|done`, `/classify`, `/ready`, `/sync`) ARE the contract; canonical
  event table mapping each to Claude/Cursor/Codex/OpenCode mechanisms.

**Phase 5 — Usage accounting (multi-source, event-driven).** Graph: `local/ms1`–`local/ms4`.
- **No daemon harness mode** (`local/ms1`): `lib/harness.js` is a registry (`all()`, namespace
  routing), not `ZONOID_HARNESS` / `active()`. Daemon unions all adapters concurrently; MCP
  client identity (`ORCH_CLIENT`) lives on stdio spawn only (`local/ms4`).
- **Per-session binding** (`local/ms2`): replace `mainTranscript` singleton with
  `state.sessions[sessionId]` so concurrent IDEs each retain transcript paths.
- **Usage contract** (`local/ms3`) — adapters translate, daemon accounts:
  - **Hot path:** `subagentStop` → `POST /agent/done` → adapter `usage.sample(one file)`
    → store `overlay.usage_records[agent_id]`. Subagent complete ≠ task complete; one task
    may sum many agent slices. `complete_task` does not sample.
  - **Uniform shape:** `UsageSlice` `{ harness, agent_id, session_id, transcript_path,
    task_key?, startedAt, endedAt, usage, human, overhead }` — daemon never parses IDE JSONL.
  - **Cold path reconcile** (adapter-owned triggers, not `/costflow`, no daemon global cron):
    standing per-harness timestamp `overlay.usage_reconcile[harness].at`.
    1. **sessionStart:** if `at` missing or >24h → that adapter's `usage.reconcile(ws)` once.
    2. **Adapter scheduler:** on sessionStart arm daily re-check (Claude native
       `ScheduleWakeup`; Cursor/Codex substrate; OpenCode plugin) for long-running sessions;
       fire curls `POST /usage/reconcile { harness }` with same stale-at gate.

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
- `zonoid init --harness claude|cursor|codex|opencode` wires **that IDE's** hooks + MCP spawn
  env (`ORCH_CLIENT`) — installer-only, not a daemon mode switch.
- IDE setups default to stdio MCP transport (self-boots the daemon per tool call already).
- launchd/systemd service option for always-on daemon where HTTP connectors are used.

## Frozen / non-goals

- `hooks/*.sh` behavior, Claude task flow + todo UI, existing MCP tool signatures,
  on-disk graph formats: unchanged.
- No MCP access restriction (daemon-side invariants instead). No auth until the daemon is
  exposed beyond localhost (then: one bearer token across ALL routes, HTTP + MCP alike).
- Syncing other harnesses' internal todo stores: deferred, not ruled out — revisit
  per-harness when we get there (worth it only if a store proves stable, accessible,
  and expressive enough to beat plain adoption).
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
