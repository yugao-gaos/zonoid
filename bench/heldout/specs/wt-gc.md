# Task: gcPlan

Implement `gcPlan(entries)` in a NEW file `bench/sandbox/gc-plan-ht.js` in the repo
`__INSTALL_DIR__`. Do NOT run `git commit`.

## Goal

The orchestrator's self-improvement loop creates a git worktree under `worktrees/` for every
attempt it runs (branch, code, test, judge, maybe merge). Over time the `worktrees/` directory
accumulates entries. Write the GC planner that decides, for a scan of that directory, which
entries to remove and which to leave alone.

`gcPlan(entries)` takes an array of scan entries, each:

```
{
  path: <string>,          // path of the directory entry
  isEmptyDir: <boolean>,   // true if the directory contains nothing at all
  registered: <boolean>,   // true if `git worktree list` still knows this path
  branchMerged: <boolean|null>, // true/false: is its branch fully merged into main; null: no branch exists for it
  claimed: <boolean>,      // true if an agent currently holds a claim on it
  ageHours: <number>       // hours since last modification
}
```

Return `{ reclaim: [<paths>], keep: [<paths>] }` — every input path appears in exactly one of
the two lists. Reclaimed paths are deleted permanently by the caller.

## Public examples

```
// an active, claimed worktree -> keep
{ path: 'worktrees/self/a', isEmptyDir: false, registered: true, branchMerged: false, claimed: true,  ageHours: 2 }   // keep

// merged, unclaimed, stale worktree -> reclaim
{ path: 'worktrees/self/b', isEmptyDir: false, registered: true, branchMerged: true,  claimed: false, ageHours: 72 }  // reclaim
```

## Contract

- File: `bench/sandbox/gc-plan-ht.js`, exporting `module.exports = { gcPlan };` (CommonJS).
- Pure function: no I/O, no globals, deterministic. Do not actually delete anything.
- Keep it tight. Create `bench/sandbox/` if it does not exist.

Write your best implementation and stop. Do not write any test files.
