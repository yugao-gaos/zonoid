---
name: zonoid-orchestrator
description: Use when working in a repo wired to Zonoid, especially for onboarding, repo learning, Codex adapters, CLI/MCP/HTTP/dashboard surfaces, daemon task minting, or any substantive multi-step code change. Enforces client-repo task minting through the Codex create_task file-drop path before implementation.
---

# Zonoid Orchestrator Workflow

For substantive work, act as the dispatcher first:

1. Mint a task with `mcp__orchestrator_graph.create_task`.
2. Call `suggest_links` and add relevant `context` or `blocking` edges when those tools are available.
3. Do not call `start_task` from the main dispatcher session.
4. Dispatch or move execution into an isolated attempt worktree before editing.
5. Keep the main session focused on coordination, review, and user communication.

Codex task minting uses the adapter file-drop path:

- `create_task` writes a `codex/<id>.json` task stub and calls daemon sync.
- The daemon adopts that file into the unified graph.
- Do not bypass this with direct multi-file edits in the live client repo.

Inline work is only acceptable for trivial one-liners, docs-only tweaks, read-only inspection, or test-only verification. If a test reveals a new actionable fix, mint a task for that fix.

Always surface the dashboard during orchestrator work:

`http://localhost:8787/graph?workspace=<url-encoded absolute workspace path>`
