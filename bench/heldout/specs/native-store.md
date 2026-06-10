# Task: taskStore

Implement `createTaskStore(dir)` in a NEW file `bench/sandbox/task-store-ht.js` in the
repo `__INSTALL_DIR__`. Do NOT run `git commit`.

## Goal

Claude Code keeps its native task list as one JSON file per task, `<id>.json`, inside a
directory (shape: `{ "id": "<id>", "title": "<string>", "status": "<string>" }`). The
orchestrator layers its own task status on top of that native list: agents report
richer/corrected statuses, and the rest of the system must read the layered view.

`createTaskStore(dir)` returns a store over the native task directory `dir`:

- `getTask(id)` → `{ id, title, status }`. `title` always reflects the native file.
  `status` reflects the most recent orchestrator override ever recorded for that id (via
  `setStatus`), else the native file's status. Returns `null` when `<id>.json` does not
  exist in `dir`.
- `setStatus(id, status)` → records an orchestrator status override for that task.
  Overrides are durable: a later `createTaskStore(dir)` on the same directory (e.g. in a
  fresh process) still sees them.

## Public examples

Given `dir` containing `t1.json` = `{ "id": "t1", "title": "Build the thing", "status": "pending" }`:

```
const store = createTaskStore(dir);
store.getTask('t1')                    // { id:'t1', title:'Build the thing', status:'pending' }
store.setStatus('t1', 'in_progress');
store.getTask('t1').status             // 'in_progress'
createTaskStore(dir).getTask('t1').status   // 'in_progress'  (a new instance sees it)
store.getTask('nope')                  // null
```

## Contract

- File: `bench/sandbox/task-store-ht.js`, exporting `module.exports = { createTaskStore };` (CommonJS).
- Node built-ins (`fs`, `path`, `os`) allowed; no external packages, no network.
- You may keep whatever auxiliary state you need.
- Keep it tight. Create `bench/sandbox/` if it does not exist.

Write your best implementation and stop. Do not write any test files.
