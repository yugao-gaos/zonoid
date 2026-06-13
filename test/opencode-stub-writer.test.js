#!/usr/bin/env node
// Unit test for packages/opencode-plugin/lib/stub-writer.js
// Run: node test/opencode-stub-writer.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-opencode-stub-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const sw = require('../packages/opencode-plugin/lib/stub-writer');
const fd = require('../lib/filedrop-tasks');

const WS = '/tmp/fake-opencode-workspace/app';
let pass = 0;
let fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

try {
  ok('workspaceKey matches filedrop-tasks', sw.workspaceKey(WS) === fd.workspaceKey(WS));

  const { key, file, stub } = sw.writeTaskStub(WS, {
    id: 't42',
    subject: 'OpenCode mint probe',
    description: 'via plugin stub writer',
    blockedBy: ['local/a1'],
    agent_id: 'worker-oc',
  });

  ok('key is opencode/<id>', key === 'opencode/t42');
  ok('stub file exists', fs.existsSync(file));
  ok('no .tmp left behind', !fs.existsSync(`${file}.${process.pid}.tmp`));

  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  ok('subject preserved', parsed.subject === 'OpenCode mint probe');
  ok('created_by.harness', parsed.created_by.harness === 'opencode');
  ok('created_by.agent_id', parsed.created_by.agent_id === 'worker-oc');
  ok('blockedBy preserved', parsed.blockedBy[0] === 'local/a1');

  const agg = fd.aggregateWorkspace(WS);
  ok('daemon aggregate picks up stub', agg.some((t) => t.key === 'opencode/t42'));
  ok('aggregate label from subject', agg.find((t) => t.key === 'opencode/t42').label === 'OpenCode mint probe');

  ok('missing id throws', (() => {
    try { sw.writeTaskStub(WS, { subject: 'x' }); return false; }
    catch (e) { return /required/.test(e.message); }
  })());

  console.log(`\n${pass}/${pass + fail} assertions passed`);
  if (fail) process.exit(1);
} finally {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}
