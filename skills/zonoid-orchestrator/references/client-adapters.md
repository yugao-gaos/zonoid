# Client Adapter Mappings

Use this reference only when a task needs client-specific tool names, file-drop paths, or hook
behavior. Keep `zonoid-orchestrator/SKILL.md` client-neutral.

## Shared Contract

- Substantive edits go through a graph task.
- Dispatchers wire tasks before workers claim them.
- Workers call `branch_task(task_key)` before `start_task(task_key, agent_id)`.
- Workers edit only in the registered attempt worktree and commit before `complete_task`.
- The dashboard URL is `http://localhost:8787/graph?workspace=<url-encoded absolute workspace path>`.

## Codex Adapter

- Task creation uses the Codex file-drop path.
- `create_task` writes a `codex/<id>.json` task stub and calls daemon sync.
- The daemon adopts the file into the unified graph.
- Do not bypass this path with direct multi-file edits in the live client repo.

## OpenCode Adapter

- Task creation uses the OpenCode plugin file-drop path.
- `task_create` writes an `opencode/<id>.json` task stub and calls daemon sync.
- The daemon adopts the file into the unified graph.
- The write gate is enforced by the plugin `tool.execute.before` hook.
