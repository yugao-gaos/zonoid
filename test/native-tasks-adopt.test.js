#!/usr/bin/env node
// Unit test for adopt-on-first-sight precedence flip in lib/native-tasks.js aggregateWorkspace.
// Run: node test/native-tasks-adopt.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const nt = require('../lib/native-tasks');

const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-nt-adopt-ws-')));
const SESSION = `aaaaaaaa0000${process.pid.toString(16).padStart(8, '0')}`;
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', nt.encodeWorkspace(WS));
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', SESSION);
const KEY = (id) => `${SESSION}/${id}`;

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const writeTask = (id, obj) => {
  fs.writeFileSync(path.join(TASKS_DIR, `${id}.json`), JSON.stringify({ id: String(id), status: 'pending', blockedBy: [], ...obj }, null, 2));
};

try {
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, `${SESSION}.jsonl`), '');
  fs.mkdirSync(TASKS_DIR, { recursive: true });

  writeTask('1', { subject: 'original title', description: 'orig desc', blockedBy: ['9'] });
  writeTask('9', { subject: 'blocker' });

  // No snapshot: native authoritative (back-compat / pre-adoption).
  let agg = nt.aggregateWorkspace(WS, {});
  const t1 = agg.find((t) => t.key === KEY('1'));
  ok('pre-adoption: label from native', t1 && t1.label === 'original title');
  ok('pre-adoption: deps from native blockedBy', t1 && t1.deps.includes(KEY('9')));

  const snapshots = {
    [KEY('1')]: { subject: 'adopted title', description: 'adopted desc', status: 'pending', blockedBy: [] },
  };
  writeTask('1', { subject: 'echo title', status: 'in_progress', blockedBy: ['9'] });

  agg = nt.aggregateWorkspace(WS, snapshots);
  const adopted = agg.find((t) => t.key === KEY('1'));
  ok('post-adoption: live echo title', adopted && adopted.label === 'echo title');
  ok('post-adoption: live echo status', adopted && adopted.native_status === 'in_progress');
  ok('post-adoption: description from snapshot', adopted && adopted.description === 'adopted desc');
  ok('post-adoption: blockedBy from snapshot not native', adopted && adopted.deps.length === 0);

  fs.rmSync(path.join(TASKS_DIR, '1.json'));
  agg = nt.aggregateWorkspace(WS, snapshots);
  ok('native gone: snapshot fallback serves node', agg.some((t) => t.key === KEY('1') && t.label === 'adopted title'));
  const crossNs = {
    [KEY('x')]: { subject: 'cross ns dep', description: '', status: 'pending', blockedBy: ['local/h4'] },
  };
  agg = nt.aggregateWorkspace(WS, crossNs);
  const cross = agg.find((t) => t.key === KEY('x'));
  ok('namespaced blockedBy resolves without double prefix', cross && cross.deps.includes('local/h4') && !cross.deps.includes('local/local/h4'));

} finally {
  try { fs.rmSync(TASKS_DIR, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(PROJ_DIR, { recursive: true, force: true }); } catch { /* */ }
  try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* */ }
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
