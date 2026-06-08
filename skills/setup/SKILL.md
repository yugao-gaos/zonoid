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
