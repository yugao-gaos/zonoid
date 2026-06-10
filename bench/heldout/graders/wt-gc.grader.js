'use strict';
// HELD-OUT grader for the wt-gc candidate. The agent NEVER sees this file.
//
// Usage: node wt-gc.grader.js <frozen-artifact.js>
// The PROSE SPEC shows only the obvious rows (claimed active -> keep; merged stale -> reclaim).
// The REAL directory contains the cruft shapes from the recorded GC-policy note (the seeded
// empirical knowledge): the loop accumulated EMPTY PARENT DIRS and ORPHANED (unregistered)
// attempt worktrees. The recorded policy is two-sided:
//   - GC once value is extracted: empty parent dirs and merged, unclaimed orphans -> reclaim;
//   - NEVER silently orphan un-judged work: unmerged work is kept no matter how old/unregistered.
// A single naive heuristic fails one side or the other: "reclaim merged+stale only" keeps the
// cruft; "reclaim anything unregistered/old" deletes un-judged work. Edge cases test both sides.
const fs = require('fs');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}
let gcPlan, loadErr = null;
try { ({ gcPlan } = require(path.resolve(artifact))); } catch (e) { loadErr = e.message; }

const E = (path_, isEmptyDir, registered, branchMerged, claimed, ageHours) =>
  ({ path: path_, isEmptyDir, registered, branchMerged, claimed, ageHours });

const entries = [
  // non-edge rows (spec-derivable)
  E('worktrees/self/active', false, true, false, true, 2),          // claimed active -> keep
  E('worktrees/self/merged-stale', false, true, true, false, 72),   // public example -> reclaim
  E('worktrees/self/young-unmerged', false, true, false, false, 3), // young unmerged -> keep
  E('worktrees/self/claimed-merged', false, true, true, true, 100), // claimed -> keep
  // EDGE rows (note-only)
  E('worktrees/bench', true, false, null, false, 30),               // empty parent dir -> reclaim
  E('worktrees/self/old-task', true, false, null, false, 90),       // empty parent dir -> reclaim
  E('worktrees/self/orphan-merged', false, false, true, false, 50), // orphaned attempt, value extracted -> reclaim
  E('worktrees/self/orphan-unmerged', false, false, false, false, 50), // un-judged work -> KEEP, never delete
  E('worktrees/self/ancient-unmerged', false, true, false, false, 200), // old but value not extracted -> KEEP
];
const want = {
  'worktrees/self/active': 'keep',
  'worktrees/self/merged-stale': 'reclaim',
  'worktrees/self/young-unmerged': 'keep',
  'worktrees/self/claimed-merged': 'keep',
  'worktrees/bench': 'reclaim',
  'worktrees/self/old-task': 'reclaim',
  'worktrees/self/orphan-merged': 'reclaim',
  'worktrees/self/orphan-unmerged': 'keep',
  'worktrees/self/ancient-unmerged': 'keep',
};
const edgePaths = new Set(['worktrees/bench', 'worktrees/self/old-task', 'worktrees/self/orphan-merged',
  'worktrees/self/orphan-unmerged', 'worktrees/self/ancient-unmerged']);

let plan = null, planErr = null;
if (typeof gcPlan !== 'function') planErr = loadErr || 'no gcPlan export';
else { try { plan = gcPlan(entries.map((e) => ({ ...e }))); } catch (e) { planErr = e.message; } }

const cases = [];
// structural non-edge case: every path in exactly one list
{
  let pass = false;
  if (plan && Array.isArray(plan.reclaim) && Array.isArray(plan.keep)) {
    const all = [...plan.reclaim, ...plan.keep];
    pass = all.length === entries.length && new Set(all).size === entries.length
      && entries.every((e) => all.includes(e.path));
  }
  cases.push({ name: 'partition complete and disjoint', edge: false, pass, err: planErr });
}
for (const e of entries) {
  const w = want[e.path];
  let got = null;
  if (plan && Array.isArray(plan.reclaim) && Array.isArray(plan.keep)) {
    got = plan.reclaim.includes(e.path) ? 'reclaim' : plan.keep.includes(e.path) ? 'keep' : 'missing';
  }
  cases.push({ name: `${e.path} -> ${w}`, edge: edgePaths.has(e.path), pass: got === w, want: w, got, err: planErr });
}

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({ ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length }));
