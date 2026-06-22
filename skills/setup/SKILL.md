---
name: setup
description: Orchestrator setup & doctor/wizard. Checks the daemon, detects Agent Teams / workflow availability, explains the per-conversation toggle, and (interactively, step by step) sets up locally-trusted HTTPS via mkcert so the daemon can be added as a custom connector for inline MCP Apps UI. Run when installing the orchestrator, when "team" routing isn't working, when the user wants the inline-chat dashboard, when scheduled tasks keep prompting for permissions on every run, or when recreating/migrating scheduled tasks to a new workspace.
---

# Orchestrator setup / doctor / wizard

Run the relevant checks, print a short status table, then offer the next action. Be
idempotent — detect what's already done and skip it. Never run a step that needs a password
silently; tell the user what to expect.

`INSTALL=${ZONOID_REPO:-$HOME/.claude/orchestrator}` · `DATA=$(node -e "console.log(require('$INSTALL/lib/runtime-paths').resolveDataDir())")` · `PORT=8787` · `HTTPS_PORT=8788`

## 1. Health
- Daemon: `curl -s --max-time 1 localhost:8787/ping`. If down, it should self-boot from the
  MCP server; otherwise `node "$INSTALL/daemon.js" &`.
- Web/preview dashboard: `$INSTALL/public/graph.html` (or the workspace copy)
  in the desktop preview pane — confirmed working, no cert needed.

## 2. Native features (read-only)
- Agent Teams: enabled iff `~/.claude/settings.json` has `.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=="1"` (needs Claude Code ≥2.1.32). Tool works without it.
- Workflows: on by default unless `.disableWorkflows==true`. `claude --version` to check.

## 3. Per-conversation toggle
Harness is ON by default per conversation: `orch off` disables, `orch on` re-enables.

## 4. HTTPS / inline-UI connector wizard (interactive)
Goal: serve the daemon's `/mcp` over locally-trusted HTTPS so it can be added as a **custom
connector** — the only surface that renders inline MCP Apps UI in the desktop app. All local;
nothing is exposed publicly.

**Detect state first** (skip finished steps):
- `command -v mkcert` — installed?
- `ls "$DATA/certs/cert.pem" "$DATA/certs/key.pem"` — certs exist?
- `curl -sk --max-time 1 https://localhost:8788/ping` — HTTPS listener up?

**Then do only what's missing:**
1. **Install mkcert** (no password): `brew install mkcert nss` (or `brew install mkcert`).
2. **Install the local CA** — `mkcert -install`. ⚠️ Tell the user: *"a macOS password/Keychain
   dialog will pop up — approve it."* Run it; if it errors needing a terminal sudo, ask the
   user to run `mkcert -install` themselves in a terminal, then continue.
3. **Generate the cert** (no password): `mkdir -p "$DATA/certs" && mkcert -cert-file "$DATA/certs/cert.pem" -key-file "$DATA/certs/key.pem" localhost 127.0.0.1`.
   (Steps 1–3 are bundled in `$INSTALL/scripts/setup-https.sh`.)
4. **Restart the daemon** so it picks up the cert: `pkill -9 -f daemon.js; (it auto-reboots
   from the MCP server, or run it). Verify: `curl -sk https://localhost:8788/mcp -X OPTIONS -o /dev/null -w '%{http_code}'` → expect `204`.
5. **Add the connector (manual — UI step the user must do):** Settings → Connectors →
   Add custom connector → URL `https://localhost:8788/mcp`, No Auth. Then ask Claude to
   `show_dashboard` — the inline panel should render.

**Honesty:** the connector-add is a UI action only the user can do; inline UI is gated to the
connector path (local stdio servers don't render it). If the connector flow can't be reached
or rejects the URL, the **preview panel** (step 1) remains the working in-app dashboard.

## 5. Optional: enable Agent Teams (with consent)
If the user wants it: show the change, get explicit confirmation, then merge
`.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS="1"` into `~/.claude/settings.json`; note it needs
a Claude Code restart. The tool works without it ("team" routing falls back to Workflow).

## 6. Permissions allowlist (subagent unblock)

Background subagents (orch-loop, orch-loop-recovery cron, scheduled tasks) inherit the
session's permission settings. Without an explicit allowlist in `.claude/settings.local.json`,
every tool call prompts — blocking unattended runs.

**Detect state:** check if `<workspace>/.claude/settings.local.json` exists and has
`permissions.allow` with at least the core entries below.

**Write if missing or incomplete** (idempotent — merge, don't clobber):
```json
{
  "permissions": {
    "allow": [
      "Read",
      "Bash(curl*)", "Bash(ls*)", "Bash(cat*)", "Bash(find*)", "Bash(grep*)", "Bash(jq*)", "Bash(node*)",
      "mcp__orchestrator-graph__next_action", "mcp__orchestrator-graph__get_graph",
      "mcp__orchestrator-graph__set_status", "mcp__orchestrator-graph__start_task",
      "mcp__orchestrator-graph__complete_task", "mcp__orchestrator-graph__record_decision",
      "mcp__orchestrator-graph__search_knowledge", "mcp__orchestrator-graph__get_learnings",
      "mcp__orchestrator-graph__get_task_detail", "mcp__orchestrator-graph__list_agents",
      "mcp__orchestrator-graph__list_guidance", "mcp__orchestrator-graph__request_guidance",
      "mcp__orchestrator-graph__loop_control", "mcp__orchestrator-graph__suggest_links",
      "mcp__orchestrator-graph__attach_knowledge", "mcp__orchestrator-graph__branch_task",
      "mcp__orchestrator-graph__add_dependency", "mcp__orchestrator-graph__remove_dependency",
      "mcp__orchestrator-graph__get_dependency_summaries", "mcp__orchestrator-graph__graph_delta",
      "mcp__orchestrator-graph__show_dashboard", "mcp__orchestrator-graph__peek_workspace",
      "mcp__orchestrator-graph__drain_kb_batch", "mcp__orchestrator-graph__enqueue_kb",
      "mcp__orchestrator-graph__measure_task", "mcp__orchestrator-graph__merge_attempt",
      "mcp__orchestrator-graph__remove_worktree", "mcp__orchestrator-graph__supersede_note",
      "mcp__orchestrator-graph__supersede_task", "mcp__orchestrator-graph__configure_task",
      "TaskCreate", "TaskUpdate", "TaskGet", "TaskList",
      "ScheduleWakeup", "Agent"
    ]
  }
}
```
`settings.local.json` is gitignored/local — safe to write freely.

## 7. Scheduled tasks (idempotent install)

Two scheduled tasks are required infrastructure — install them if missing.

**Detect workspace path first** — run `git rev-parse --show-toplevel` in the current directory. If that fails (not a git repo), use `$PWD`. Call this `WORKSPACE`. Substitute it verbatim into every prompt below — never hardcode a path.

**Detect state:** call `mcp__scheduled-tasks__list_scheduled_tasks`. Check for `nightly-orchestrator-qa` and `orch-loop-recovery`. Install only what's missing.

**`nightly-orchestrator-qa`** — deep self-learn QA sweep, runs at 2:09am daily:
- cronExpression: `9 2 * * *`
- description: `Nightly self-learn QA sweep over the orchestrator task graph (daemon :8787), per skills/self-learn-qa`
- prompt: `Invoke the self-learn-qa skill. Workspace: <WORKSPACE>. Orchestrator daemon: http://localhost:8787.`

**`orch-loop-recovery`** — recovery driver, runs every 5 minutes:
- cronExpression: `*/5 * * * *`
- description: `Recovery driver: keeps the orchestrator task graph moving by ensuring an active loop exists and polling next_action every 5 minutes`
- notifyOnCompletion: false
- prompt:
  > You are the orchestrator recovery driver for the workspace at <WORKSPACE>. Your job is lightweight: ensure the task graph keeps moving. Run fast, do the minimum.
  >
  > 1. Call `mcp__orchestrator-graph__next_action`. If empty `loops` array, go to step 2. If entries exist, go to step 3.
  > 2. No active loop — call `mcp__orchestrator-graph__get_graph` (scope: "frontier"). If `ready` tasks exist: call `loop_control({ action: "start", tokenBudget: 80000, maxIterations: 100, minPoll: 30, maxPoll: 300, batch: 4, maxConcurrency: 6 })`, then `next_action` again, go to step 3. If no `ready` tasks: exit silently.
  > 3. Act on each loop entry: `stop`/`idle` → nothing. `spawn` → for each task ask Subconscious for an assignment (`subconscious_assignment prepare`), then dispatch a background subagent (Agent tool, run_in_background: true) with prompt: "You are a worker agent. TASK_ID: <key> (<label>). Workspace: <WORKSPACE>. Daemon: http://localhost:8787. Accept the prepared assignment with subconscious_assignment accept, do the work, then subconscious_assignment complete with status done/tested on success or failed on failure. Never exit silently." `judge_edges`/`plan`/`optimize`/`await_user` → ignore.
  > 4. Done. Do not reschedule. Never call request_guidance. If daemon unreachable, exit silently.

After installing, tell the user to click **"Run now"** on `orch-loop-recovery` in the Scheduled sidebar to pre-approve tool permissions for future unattended runs.

## 8. First-run KB onboarding (drop-in entry, human-gated)
When setup runs in a **new repo** (one with no KB bootstrapped yet), offer to onboard it so a
fresh project gets a starter knowledge base. This is the drop-in entry point.

**Detect first-run** (skip if already onboarded — the entry is idempotent):
- `REPO="$(git -C . rev-parse --show-toplevel 2>/dev/null)"` — the target repo.
- `ls "$REPO/.graph/.onboarded"` — present ⇒ already onboarded, skip.

**Then, only if missing, trigger the entry point:**
```
node "$BASE/scripts/onboard.js" --repo "$REPO"
```
This MINES the repo (structure/git/docs), runs the agentic learner to VALIDATE candidates, and
writes a review bundle `bench/onboard/<repo>/ONBOARD-REVIEW.md`. It **mines and validates only —
it does NOT touch the live graph.** (Sandboxed/offline? add `--skip-learn` to bundle the raw
mined candidates without spawning the validation agent.)

**Review gate (mandatory — NO auto-inject).** Point the user at `ONBOARD-REVIEW.md` for keep/drop
approval. Injection is a SEPARATE explicit step that reuses the reversible `[ingest]` overlay-note
gate — never run it automatically:
```
node "$BASE/scripts/onboard-learn.js" --repo "$REPO" --in "$REPO/.graph/onboard" --inject            # dry-run plan
node "$BASE/scripts/onboard-learn.js" --repo "$REPO" --in "$REPO/.graph/onboard" --inject --confirm  # inject (human-approved)
```
**Honesty:** `onboard.js` has no inject path of its own; the `--confirm` gate cannot be reached
from the setup trigger. Every injected node is titled `[ingest] …` and stays filterable/removable.

## 9. Graph auto-commit hook (optional)

Installs a `post-commit` git hook that calls `claude` after each real code commit to stage and commit `.graph/` node files changed since the last graph snapshot. Uses a `.git/GRAPH_CHECKPOINT` marker to track what's been committed — catches all pending changes, not just the narrow commit window.

**Detect state:** check if `<workspace>/.git/hooks/post-commit` exists and contains `ORCH_GRAPH_AUTOCOMMIT`.

**Install if missing:**

Write `<workspace>/.git/hooks/post-commit`:
```sh
#!/bin/sh
[ "${ORCH_GRAPH_AUTOCOMMIT}" = "1" ] || exit 0

CHECKPOINT=".git/GRAPH_CHECKPOINT"
REPO_ROOT=$(git rev-parse --show-toplevel)
COMMIT_HASH=$(git rev-parse --short HEAD)

# On first run, catch all pending changes
[ -f "$CHECKPOINT" ] || touch -t 197001010000 "$CHECKPOINT"

# Find .graph/ files modified since last snapshot
CHANGED=$(find .graph -name "*.jsonl" -newer "$CHECKPOINT" 2>/dev/null)
[ -n "$CHANGED" ] || exit 0

claude --dangerously-skip-permissions -p "
The git commit $COMMIT_HASH just landed in $REPO_ROOT.
Stage and commit these .graph/ files (changed since last graph snapshot):

$CHANGED

Steps:
1. git add $CHANGED
2. git commit --no-verify -m 'chore: graph snapshot [$COMMIT_HASH]'
3. touch $REPO_ROOT/$CHECKPOINT

Do not touch anything outside .graph/.
" 2>/dev/null &
```

Make it executable: `chmod +x <workspace>/.git/hooks/post-commit`

**Add the flag to `~/.claude/settings.json`:** merge `"ORCH_GRAPH_AUTOCOMMIT": "0"` into the `env` object (off by default). Read the file first and merge carefully — do not clobber existing keys.

**Tell the user:** set `ORCH_GRAPH_AUTOCOMMIT=1` in `~/.claude/settings.json` env block to enable. The hook runs after every commit; if no `.graph/` changes are pending it exits instantly.
