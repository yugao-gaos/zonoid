#!/usr/bin/env node
// Unit test for lib/filedrop-tasks.js — the designated-folder (file-drop) task source.
// Run: node test/filedrop-tasks.test.js  — exits non-zero on any failed assertion.
// Uses a tmp-dir CLAUDE_PLUGIN_DATA sandbox; never touches real daemon data.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-filedrop-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX; // must precede the require (module reads env at load)
const fd = require('../lib/filedrop-tasks');
const overlayStore = require('../lib/overlay');

const WS = '/tmp/fake-workspace/proj';
let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const write = (harness, name, obj) => {
  const dir = path.join(fd.dirFor(WS), harness);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), typeof obj === 'string' ? obj : JSON.stringify(obj, null, 2));
};

try {
  // --- layout: workspace-key naming matches the overlay store's collision-free scheme ---
  const ovBase = path.basename(overlayStore.fileFor(WS), '.json');
  ok('workspaceKey matches overlay fileFor naming', fd.workspaceKey(WS) === ovBase);
  ok('dirFor is <dataDir>/tasks/<workspace-key>', fd.dirFor(WS) === path.join(SANDBOX, 'tasks', fd.workspaceKey(WS)));

  // --- reader: missing folder, valid stub, defaults ---
  ok('aggregate of missing folder is []', fd.aggregateWorkspace(WS).length === 0);
  write('cursor', 'abc123.json', { id: 'abc123', subject: 'build the widget', description: 'desc here', status: 'pending', blockedBy: [], created_by: { harness: 'cursor', agent_id: 'agent-1' } });
  let agg = fd.aggregateWorkspace(WS);
  ok('valid stub read', agg.length === 1);
  ok('key is <harness>/<id>', agg[0].key === 'cursor/abc123');
  ok('session field carries the harness', agg[0].session === 'cursor');
  ok('label from subject', agg[0].label === 'build the widget');
  ok('description carried', agg[0].description === 'desc here');
  ok('native_status carried', agg[0].native_status === 'pending');

  // --- defaults: status omitted -> pending; description omitted -> '' ---
  write('cursor', 'min.json', { id: 'min', subject: 'minimal stub' });
  agg = fd.aggregateWorkspace(WS);
  const min = agg.find((t) => t.key === 'cursor/min');
  ok('status defaults to pending', min && min.native_status === 'pending');
  ok('description defaults to empty', min && min.description === '');
  ok('deps default to []', min && Array.isArray(min.deps) && min.deps.length === 0);

  // --- tolerance: partial/unparseable skipped, .tmp ignored, id/subject required ---
  write('cursor', 'broken.json', '{ "id": "broken", "subject": ');           // unparseable
  write('cursor', 'noid.json', { subject: 'no id present' });                // id required
  write('cursor', 'nosubject.json', { id: 'nosubject' });                    // subject required
  write('cursor', `inflight.json.${process.pid}.tmp`, { id: 'inflight', subject: 'mid-write' }); // atomic-write tmp
  write('cursor', 'notes.txt', 'not a task');                                // non-json ignored
  agg = fd.aggregateWorkspace(WS);
  ok('unparseable stub skipped', !agg.some((t) => t.id === 'broken'));
  ok('stub missing id skipped', !agg.some((t) => t.label === 'no id present'));
  ok('stub missing subject skipped', !agg.some((t) => t.id === 'nosubject'));
  ok('*.tmp ignored', !agg.some((t) => t.id === 'inflight'));
  ok('only the two valid stubs survive', agg.length === 2);

  // --- blockedBy namespacing: bare ids get the stub's harness; keys with '/' pass verbatim ---
  write('codex', 'x1.json', { id: 'x1', subject: 'cross-ns blocked', blockedBy: ['abc123', 'cursor/min', 'deadbeef-uuid/42'] });
  agg = fd.aggregateWorkspace(WS);
  const x1 = agg.find((t) => t.key === 'codex/x1');
  ok('bare blockedBy id namespaced to own harness', x1 && x1.deps.includes('codex/abc123'));
  ok('cross-harness blockedBy key passes verbatim', x1 && x1.deps.includes('cursor/min'));
  ok('claude-session blockedBy key passes verbatim', x1 && x1.deps.includes('deadbeef-uuid/42'));
  ok('any harness-named subfolder accepted (codex)', agg.filter((t) => t.session === 'codex').length === 1);

  // --- readStub / stubFile / splitKey ---
  ok('readStub returns raw stub', (fd.readStub(WS, 'cursor/abc123') || {}).subject === 'build the widget');
  ok('readStub null for missing', fd.readStub(WS, 'cursor/nope') === null);
  ok('splitKey null on unkeyed', fd.splitKey('nokey') === null && fd.splitKey('') === null && fd.splitKey('x/') === null);

  // --- writeStatus: atomic in-place status update, preserving other fields ---
  ok('writeStatus true on existing stub', fd.writeStatus(WS, 'cursor/abc123', 'in_progress') === true);
  let after = fd.readStub(WS, 'cursor/abc123');
  ok('status updated', after.status === 'in_progress');
  ok('subject preserved', after.subject === 'build the widget');
  ok('created_by preserved', after.created_by && after.created_by.agent_id === 'agent-1');
  ok('writeStatus false when no stub (ownership test for session keys)', fd.writeStatus(WS, 'deadbeef-uuid/42', 'pending') === false);
  ok('writeStatus false on unkeyed input', fd.writeStatus(WS, 'plain', 'pending') === false);
  ok('no tmp left behind', fs.readdirSync(path.join(fd.dirFor(WS), 'cursor')).filter((f) => f.includes('.tmp')).length === 1); // only our deliberate fixture

  // --- watch: fires on a stub drop; disposer doesn't throw ---
  (async () => {
    let fired = false;
    const dispose = fd.watch(() => { fired = true; });
    write('cursor', 'watched.json', { id: 'watched', subject: 'watch me' });
    await new Promise((r) => setTimeout(r, 500));
    ok('watch fires on stub drop', fired);
    dispose();

    console.log('-----');
    console.log(`${pass} passed, ${fail} failed`);
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    process.exit(fail === 0 ? 0 : 1);
  })();
} catch (e) {
  console.error(e);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  process.exit(1);
}
