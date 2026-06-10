---
name: setup
description: Orchestrator setup & doctor/wizard. Checks the daemon, detects Agent Teams / workflow availability, explains the per-conversation toggle, and (interactively, step by step) sets up locally-trusted HTTPS via mkcert so the daemon can be added as a custom connector for inline MCP Apps UI. Run when installing the orchestrator, when "team" routing isn't working, or when the user wants the inline-chat dashboard.
---

# Orchestrator setup / doctor / wizard

Run the relevant checks, print a short status table, then offer the next action. Be
idempotent — detect what's already done and skip it. Never run a step that needs a password
silently; tell the user what to expect.

`BASE = ${CLAUDE_PLUGIN_DATA:-$HOME/.claude/orchestrator}` · `PORT=8787` · `HTTPS_PORT=8788`

## 1. Health
- Daemon: `curl -s --max-time 1 localhost:8787/ping`. If down, it should self-boot from the
  MCP server; otherwise `node ~/.claude/orchestrator/daemon.js &`.
- Web/preview dashboard: `~/.claude/orchestrator/public/graph.html` (or the workspace copy)
  in the desktop preview pane — confirmed working, no cert needed.

## 2. Native features (read-only)
- Agent Teams: enabled iff `~/.claude/settings.json` has `.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=="1"` (needs Claude Code ≥2.1.32). Tool works without it.
- Workflows: on by default unless `.disableWorkflows==true`. `claude --version` to check.

## 3. Per-conversation toggle
Harness is OFF by default per conversation: `orch on` enables, `orch off` disables.

## 4. HTTPS / inline-UI connector wizard (interactive)
Goal: serve the daemon's `/mcp` over locally-trusted HTTPS so it can be added as a **custom
connector** — the only surface that renders inline MCP Apps UI in the desktop app. All local;
nothing is exposed publicly.

**Detect state first** (skip finished steps):
- `command -v mkcert` — installed?
- `ls "$BASE/certs/cert.pem" "$BASE/certs/key.pem"` — certs exist?
- `curl -sk --max-time 1 https://localhost:8788/ping` — HTTPS listener up?

**Then do only what's missing:**
1. **Install mkcert** (no password): `brew install mkcert nss` (or `brew install mkcert`).
2. **Install the local CA** — `mkcert -install`. ⚠️ Tell the user: *"a macOS password/Keychain
   dialog will pop up — approve it."* Run it; if it errors needing a terminal sudo, ask the
   user to run `mkcert -install` themselves in a terminal, then continue.
3. **Generate the cert** (no password): `mkdir -p "$BASE/certs" && mkcert -cert-file "$BASE/certs/cert.pem" -key-file "$BASE/certs/key.pem" localhost 127.0.0.1`.
   (Steps 1–3 are bundled in `~/.claude/orchestrator/scripts/setup-https.sh`.)
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

## 6. Scheduled tasks (idempotent install)

Two scheduled tasks are required infrastructure — install them if missing.

**Detect state:** call `mcp__scheduled-tasks__list_scheduled_tasks`. Check for `nightly-orchestrator-qa` and `orch-loop-recovery`. Install only what's missing.

**`nightly-orchestrator-qa`** — deep self-learn QA sweep, runs at 2:09am daily:
- cronExpression: `9 2 * * *`
- description: `Nightly self-learn QA sweep over the orchestrator task graph (daemon :8787), per skills/self-learn-qa`
- prompt: `Invoke the self-learn-qa skill. Workspace: /Users/imyu/Desktop/cloude. Orchestrator daemon: http://localhost:8787.`

**`orch-loop-recovery`** — recovery driver, runs every 5 minutes:
- cronExpression: `*/5 * * * *`
- description: `Recovery driver: keeps the orchestrator task graph moving by ensuring an active loop exists and polling next_action every 5 minutes`
- notifyOnCompletion: false
- prompt:
  > You are the orchestrator recovery driver for the workspace at /Users/imyu/Desktop/cloude. Your job is lightweight: ensure the task graph keeps moving. Run fast, do the minimum.
  >
  > 1. Call `mcp__orchestrator-graph__next_action`. If empty `loops` array, go to step 2. If entries exist, go to step 3.
  > 2. No active loop — call `mcp__orchestrator-graph__get_full_graph` (scope: "frontier"). If `ready` tasks exist: call `loop_control({ action: "start", tokenBudget: 80000, maxIterations: 100, minPoll: 30, maxPoll: 300, batch: 4, maxConcurrency: 6 })`, then `next_action` again, go to step 3. If no `ready` tasks: exit silently.
  > 3. Act on each loop entry: `stop`/`idle` → nothing. `spawn` → for each task dispatch a background subagent (Agent tool, run_in_background: true) with prompt: "You are a worker agent. TASK_ID: <key> (<label>). Workspace: /Users/imyu/Desktop/cloude. Daemon: http://localhost:8787. Call start_task(TASK_ID, agent_id), do the work, then complete_task(TASK_ID, summary) on success or set_status(TASK_ID, 'failed', reason) on failure. Never exit silently." `judge_edges`/`plan`/`optimize`/`await_user` → ignore.
  > 4. Done. Do not reschedule. Never call request_guidance. If daemon unreachable, exit silently.

After installing, tell the user to click **"Run now"** on `orch-loop-recovery` in the Scheduled sidebar to pre-approve tool permissions for future unattended runs.

## 7. First-run KB onboarding (drop-in entry, human-gated)
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
