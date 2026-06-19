---
name: zonoid-orchestrator-opencode
description: Use when working in an OpenCode repo wired to Zonoid, especially for onboarding, repo learning, the opencode plugin, CLI/MCP/HTTP/dashboard surfaces, daemon task minting, or any substantive multi-step code change. Enforces client-repo task minting through the OpenCode task_create file-drop path before implementation.
---

# Zonoid Orchestrator Workflow (OpenCode)

For substantive work, act as the dispatcher first:

1. Mint a task with the `task_create` tool (id becomes `opencode/<id>`).
2. Call `suggest_links` and add relevant `context` or `blocking` edges when those tools are available.
3. Do not call `start_task` from the main dispatcher session.
4. Dispatch or move execution into an isolated attempt worktree before editing.
5. Keep the main session focused on coordination, review, and user communication.

OpenCode task minting uses the plugin file-drop path:

- `task_create` writes an `opencode/<id>.json` task stub and calls daemon sync.
- The daemon adopts that file into the unified graph.
- Do not bypass this with direct multi-file edits in the live client repo.

The write gate is enforced by the zonoid plugin's `tool.execute.before` hook (throw-to-block): a substantive edit without a claimed task is blocked. Claim order is enforced — `branch_task(task_key)` creates the attempt worktree, then `start_task(task_key, agent_id)` claims it; the daemon refuses a claim that has no registered worktree.

Inline work is only acceptable for trivial one-liners, docs-only tweaks, read-only inspection, or test-only verification. If a test reveals a new actionable fix, mint a task for that fix.

Always surface the dashboard during orchestrator work:

`http://localhost:8787/graph?workspace=<url-encoded absolute workspace path>`
