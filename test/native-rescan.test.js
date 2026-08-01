#!/usr/bin/env node
// Test for the periodic native-task rescan primitive (autonomy hardening, fix C).
// lib/native-tasks.sessionTaskSignature is the cheap readdir-only change detector the daemon's
// 60s sweep compares to catch task files written WITHOUT an fs.watch event (Windows silently
// drops new-file events on ~/.claude/tasks). On a signature change the sweep busts the aggregate
// cache and runs buildGraph, whose adopt-on-first-sight picks the file up — so the property to
// prove here is: a file dropped with no watcher event changes the signature, and the forced
// re-aggregation then serves the new task.
// Run: node test/native-rescan.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const nt = require('../lib/native-tasks');
const claudeAdapter = require('../lib/adapters/claude');

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-native-rescan-ws-')));
const SESSION = `bbbbbbbb0000${process.pid.toString(16).padStart(8, '0')}`;
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', nt.encodeWorkspace(WS));
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', SESSION);

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const writeTask = (id, obj) => {
  fs.writeFileSync(path.join(TASKS_DIR, `${id}.json`), JSON.stringify({ id: String(id), status: 'pending', blockedBy: [], ...obj }, null, 2));
};

try {
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, `${SESSION}.jsonl`), '');
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  writeTask('1', { subject: 'existing task' });

  // Baseline: signature is stable when nothing changed (no false-positive rescans).
  const sig1 = nt.sessionTaskSignature(WS);
  const sig1again = nt.sessionTaskSignature(WS);
  ok('signature includes the session task dir', sig1.includes(SESSION) && sig1.includes('1.json'));
  ok('signature is stable across calls with no changes', sig1 === sig1again);

  // A new task file dropped with NO watcher event changes the signature — the sweep's trigger.
  writeTask('5', { subject: 'dropped without watch event' });
  const sig2 = nt.sessionTaskSignature(WS);
  ok('new task file changes the signature', sig2 !== sig1 && sig2.includes('5.json'));

  // Simulated sweep: prev !== sig → re-aggregate. The fresh aggregate serves the new task, which
  // is exactly what buildGraph feeds adopt-on-first-sight.
  if (sig2 !== sig1) {
    const agg = nt.aggregateWorkspace(WS, {});
    ok('forced re-aggregation serves the dropped task', agg.some((t) => t.key === `${SESSION}/5` && t.label === 'dropped without watch event'));
  } else {
    ok('forced re-aggregation serves the dropped task', false);
  }

  // Non-.json noise (lock files) never changes the signature — no spurious rebuilds.
  fs.writeFileSync(path.join(TASKS_DIR, '5.json.lock'), '');
  ok('lock files do not change the signature', nt.sessionTaskSignature(WS) === sig2);

  // Deleting a task file changes the signature too (retention sweeps also invalidate).
  fs.rmSync(path.join(TASKS_DIR, '5.json'));
  ok('removed task file changes the signature', nt.sessionTaskSignature(WS) !== sig2);

  // The Claude adapter exposes the detector for the daemon sweep (typeof-guarded there).
  ok('claude adapter exposes sessionTaskSignature', typeof claudeAdapter.tasks.sessionTaskSignature === 'function'
    && claudeAdapter.tasks.sessionTaskSignature(WS) === nt.sessionTaskSignature(WS));

  // Workspace with no sessions yields an empty signature without throwing.
  const emptyWs = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-native-rescan-empty-')));
  try {
    ok('workspace with no sessions yields empty signature', nt.sessionTaskSignature(emptyWs) === '');
  } finally {
    try { fs.rmSync(emptyWs, { recursive: true, force: true }); } catch { /* */ }
  }
} finally {
  try { fs.rmSync(TASKS_DIR, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(PROJ_DIR, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* */ }
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
