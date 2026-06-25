---
name: zonoid-orchestrator
description: Use when working in a repo wired to Zonoid, especially for onboarding, repo learning, CLI/MCP/HTTP/dashboard surfaces, daemon task minting, task-graph coordination, or any substantive multi-step code change. Keeps client-specific task creation and adapter details out of the core workflow.
---

# Zonoid Orchestrator

Use the orchestrator graph as the source of truth for substantive work.

1. For substantive work, create or claim a graph task before editing.
2. Wire new tasks with relevant context or blocking edges before dispatch.
3. Keep dispatcher sessions focused on coordination, review, and user communication.
4. Do implementation in isolated attempt worktrees, then commit before completing the task.
5. Leave trivial one-liners, docs-only tweaks, read-only inspection, and test-only verification inline when the workspace rules allow it.

For adapter-specific task creation, tool names, file-drop paths, and hook notes, read
[client-adapters.md](references/client-adapters.md).

Surface the dashboard during orchestrator work:

`http://localhost:8787/graph?workspace=<url-encoded absolute workspace path>`
