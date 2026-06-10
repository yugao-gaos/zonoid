'use strict';
// HELD-OUT grader for the claim-task candidate. The agent NEVER sees this file.
//
// Usage: node claim-task.grader.js <frozen-artifact.js>
// The PROSE SPEC shows only the happy path (claim a pending task) and admits refusals exist
// without saying when. The REAL semantics come from the recorded live-collision incident (the
// seeded empirical note): a human re-plan RACED a live agent, both wrote status, last-write-won —
// the agent overrode a human cancel. Hence the safe-claim (CAS) rules the system adopted:
//   - never claim a task that is in_progress by a DIFFERENT agent (no silent steal),
//   - never resurrect a canceled task (cancel is terminal),
//   - refusals leave the task untouched.
// Edge cases test exactly those. Non-edge cases are the spec-stated behaviors.
// Deliberately NOT graded (ambiguous without richer context): claiming a done task; re-claim by
// the same agent.
const fs = require('fs');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}
let claimTask, loadErr = null;
try { ({ claimTask } = require(path.resolve(artifact))); } catch (e) { loadErr = e.message; }

const cases = [];
function run(name, edge, fn) {
  let pass = false, err = null;
  if (typeof claimTask !== 'function') err = loadErr || 'no claimTask export';
  else { try { pass = !!fn(); } catch (e) { err = e.message; } }
  cases.push({ name, edge, pass, err });
}

// ---- non-edge: spec-stated ------------------------------------------------------------------
run('pending claim succeeds and mutates', false, () => {
  const store = { tasks: { t1: { id: 't1', status: 'pending', agent: null } } };
  const r = claimTask(store, 't1', 'agent-a');
  return r && r.ok === true && r.task && r.task.status === 'in_progress' && r.task.agent === 'agent-a'
    && store.tasks.t1.status === 'in_progress' && store.tasks.t1.agent === 'agent-a';
});
run('missing task -> not_found', false, () => {
  const store = { tasks: { t1: { id: 't1', status: 'pending', agent: null } } };
  const r = claimTask(store, 'nope', 'agent-a');
  return r && r.ok === false && r.reason === 'not_found' && store.tasks.t1.status === 'pending';
});
run('claim touches only the target task', false, () => {
  const store = { tasks: {
    t1: { id: 't1', status: 'pending', agent: null },
    t2: { id: 't2', status: 'pending', agent: null },
  } };
  claimTask(store, 't1', 'agent-a');
  return store.tasks.t2.status === 'pending' && store.tasks.t2.agent === null;
});

// ---- EDGE: the collision rules --------------------------------------------------------------
run('never steal a live claim by another agent', true, () => {
  const store = { tasks: { t1: { id: 't1', status: 'in_progress', agent: 'agent-x' } } };
  const r = claimTask(store, 't1', 'agent-a');
  return r && r.ok === false && store.tasks.t1.status === 'in_progress' && store.tasks.t1.agent === 'agent-x';
});
run('never resurrect a canceled task', true, () => {
  const store = { tasks: { t1: { id: 't1', status: 'canceled', agent: null } } };
  const r = claimTask(store, 't1', 'agent-a');
  return r && r.ok === false && store.tasks.t1.status === 'canceled' && store.tasks.t1.agent === null;
});
run('canceled task with past worker stays canceled', true, () => {
  const store = { tasks: { t1: { id: 't1', status: 'canceled', agent: 'agent-x' } } };
  const r = claimTask(store, 't1', 'agent-a');
  return r && r.ok === false && store.tasks.t1.status === 'canceled' && store.tasks.t1.agent === 'agent-x';
});
run('refusal leaves task object identical', true, () => {
  const t1 = { id: 't1', status: 'in_progress', agent: 'agent-x' };
  const snapshot = JSON.stringify(t1);
  const store = { tasks: { t1 } };
  claimTask(store, 't1', 'agent-b');
  return JSON.stringify(store.tasks.t1) === snapshot;
});

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({ ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length }));
