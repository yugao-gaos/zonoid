#!/usr/bin/env node
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-opencode-stub-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const sw = require('../packages/opencode-plugin/lib/stub-writer');
const fd = require('../lib/filedrop-tasks');

const WS = '/tmp/fake-opencode-workspace/app';
let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

try {
  ok('workspaceKey matches filedrop-tasks', sw.workspaceKey(WS) === fd.workspaceKey(WS));
  const { key, file } = sw.writeTaskStub(WS, {
    id: 't42', subject: 'OpenCode mint', blockedBy: ['local/a1'], agent_id: 'worker-oc',
  });
  ok('key is opencode/<id>', key === 'opencode/t42');
  ok('stub file exists', fs.existsSync(file));
  ok('aggregate picks up stub', fd.aggregateWorkspace(WS).some((t) => t.key === 'opencode/t42'));
  const trimmed = sw.writeTaskStub(WS, {
    id: '  trimmed_id-1.2  ', subject: 'Trimmed id',
  });
  ok('task id is trimmed', trimmed.key === 'opencode/trimmed_id-1.2');
  ok('trimmed stub stays in opencode task dir',
    path.dirname(trimmed.file) === path.join(sw.dirFor(WS), sw.HARNESS));
  ok('missing id throws', (() => {
    try { sw.writeTaskStub(WS, { subject: 'x' }); return false; }
    catch (e) { return /required/.test(e.message); }
  })());
  ok('path-like id throws', (() => {
    try { sw.writeTaskStub(WS, { id: '../escape', subject: 'x' }); return false; }
    catch (e) { return /letters, numbers, dot, underscore, and dash/.test(e.message); }
  })());
  ok('id with slash throws', (() => {
    try { sw.stubPath(WS, 'nested/task'); return false; }
    catch (e) { return /letters, numbers, dot, underscore, and dash/.test(e.message); }
  })());
  console.log(`\n${pass}/${pass + fail} assertions passed`);
  if (fail) process.exit(1);
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}
