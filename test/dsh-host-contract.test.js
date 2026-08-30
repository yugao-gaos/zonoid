#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const fixtureDir = path.join(__dirname, 'fixtures', 'dsh-host-contract');
const contract = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'contract.json'), 'utf8'));
const receipt = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'probe-receipt.json'), 'utf8'));
const docs = fs.readFileSync(path.join(root, 'docs', 'dsh-host-contract.md'), 'utf8');

assert.deepEqual(contract.invocation.headless, ['--profile', 'headless', '<task>']);
assert.equal(contract.mcp.publicToolPrefix, 'mcp__zonoid__');
assert.equal(contract.identity.workspacePathSource, 'agent.session.header.cwd');
assert.equal(contract.blocking.preDenySkipsBody, true);
assert.equal(contract.blocking.postBlockReturnsError, true);
assert.equal(contract.teardown.processShutdownTimeoutMs, 5000);
assert.equal(receipt.host.version, contract.host.version);
assert.equal(receipt.host.revision, contract.host.gitRevision);
assert.deepEqual(receipt.blocking, {
  allowSucceeded: true,
  preDenySkippedBody: true,
  postBlockReturnedError: true,
});
assert.ok(receipt.lifecycle.some(event => event.startsWith('session/event:')));
for (const event of ['session/created', 'session/flush', 'agent/created', 'agent/disposed', 'session/disposed']) {
  assert.ok(receipt.lifecycle.includes(event), `live receipt must contain ${event}`);
}
assert.equal(receipt.mcp.toolCallCount, 2, 'pre-denied call must not reach the MCP child');
assert.equal(receipt.mcp.requests.at(-1), 'stdio/eof');
assert.deepEqual(receipt.teardown, { pluginDisposed: true, mcpStdioClosed: true });

for (const value of [contract.host.version, contract.host.tag, contract.host.gitRevision]) {
  assert.ok(docs.includes(value), `docs must pin ${value}`);
}
for (const event of [...contract.events.lifecycle, ...contract.events.toolPipeline]) {
  assert.ok(docs.includes(event), `docs must explain ${event}`);
}

const probe = spawnSync(process.execPath, [path.join(root, 'scripts', 'probe-dsh-host-contract.js')], {
  cwd: root,
  encoding: 'utf8',
});
assert.equal(probe.status, 0, `${probe.stdout}\n${probe.stderr}`);
assert.match(probe.stdout, /fixtures verified/);
console.log('PASS  pinned DSH host contract, fixtures, and probe are consistent');
