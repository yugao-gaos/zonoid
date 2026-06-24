#!/usr/bin/env node
// Plain Node test for the per-repo test-command config: overlay.setTestCmd set/clear,
// testCmdFor reads, save/load persistence (nested under config), back-compat load of an old
// overlay (no config.test_cmds map), and the daemon's absolute-path gate (mirrored here for a
// direct unit assertion — same check POST /config enforces). STORE/RETRIEVE ONLY: the daemon
// never executes these commands; agents (e.g. the nightly QA loop) look them up and run them.
// No framework; matches the style of test/repo-target.test.js. Run: node test/test-cmd.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox BASE so overlays land in a temp dir (BASE is read at require-time).
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-testcmd-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const overlay = require('../lib/overlay');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-testcmd-ws-')));
const REPO = '/abs/path/to/some-repo';
const OTHER = '/abs/path/to/other-repo';
try {
  // --- setTestCmd set / read / clear ---
  const ov = overlay.EMPTY();
  ok('config map present in EMPTY()', ov.config && typeof ov.config === 'object');
  ok('testCmdFor null when nothing set', overlay.testCmdFor(ov, REPO) === null);
  ok('testCmdFor null for a null repo path', overlay.testCmdFor(ov, null) === null);
  overlay.setTestCmd(ov, REPO, 'npm test');
  ok('setTestCmd records the command', ov.config.test_cmds[REPO] === 'npm test');
  ok('testCmdFor reads it back', overlay.testCmdFor(ov, REPO) === 'npm test');
  ok('other repos stay unset', overlay.testCmdFor(ov, OTHER) === null);
  overlay.setTestCmd(ov, OTHER, 'bash test/smoke.sh');
  ok('two repos keyed independently', overlay.testCmdFor(ov, REPO) === 'npm test' && overlay.testCmdFor(ov, OTHER) === 'bash test/smoke.sh');
  overlay.setTestCmd(ov, REPO, 'node --test');
  ok('re-set overwrites the command', overlay.testCmdFor(ov, REPO) === 'node --test');
  overlay.setTestCmd(ov, REPO, '');
  ok('empty cmd clears the entry', ov.config.test_cmds[REPO] === undefined && overlay.testCmdFor(ov, REPO) === null);
  ok('clearing one repo leaves the other', overlay.testCmdFor(ov, OTHER) === 'bash test/smoke.sh');
  overlay.setTestCmd(ov, REPO, 'python3 bench/zonoid_bench/smoke.py');
  ok('stale bench smoke command is not stored as a routine test gate', ov.config.test_cmds[REPO] === undefined && overlay.testCmdFor(ov, REPO) === null);
  ov.config.test_cmds[REPO] = 'python3 bench/zonoid_bench/smoke.py';
  ok('legacy stored bench smoke command reads as unset', overlay.testCmdFor(ov, REPO) === null);

  // --- save / load persistence (nested under config, alongside the rest of the config) ---
  overlay.setTestCmd(ov, REPO, 'npm test');
  ov.config.require_review = true;            // a neighboring config field rides along
  overlay.save(workspace, ov);
  const loaded = overlay.load(workspace);
  ok('test_cmd persists across save/load', overlay.testCmdFor(loaded, REPO) === 'npm test');
  ok('neighboring config fields untouched', loaded.config.require_review === true);

  // --- back-compat: load an OLD overlay written before test_cmds existed ---
  const old = overlay.EMPTY();
  old.config.require_review = true;           // pre-feature overlay: config exists, no test_cmds
  overlay.save(workspace, old);
  const back = overlay.load(workspace);
  ok('old overlay reads as unset (no throw)', overlay.testCmdFor(back, REPO) === null);
  overlay.setTestCmd(back, REPO, 'npm test'); // setter lazily creates the map
  ok('setTestCmd works after back-fill', overlay.testCmdFor(back, REPO) === 'npm test');

  // --- absolute-path gate (mirrors the POST /config check: path.isAbsolute on each key) ---
  ok('absolute repo path passes the gate', path.isAbsolute(REPO) === true);
  ok('relative repo path fails the gate', path.isAbsolute('some-repo') === false);
} finally {
  for (const d of [workspace, SANDBOX]) fs.rmSync(d, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
