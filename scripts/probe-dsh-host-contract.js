#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { pathToFileURL } = require('url');
const { spawnSync } = require('child_process');

const root = path.resolve(__dirname, '..');
const fixtures = path.join(root, 'test', 'fixtures', 'dsh-host-contract');
const contract = JSON.parse(fs.readFileSync(path.join(fixtures, 'contract.json'), 'utf8'));

function command(command, args, options = {}) {
  const result = spawnSync(command, args, {
    encoding: 'utf8',
    timeout: 30_000,
    ...options,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(' ')} exited ${result.status}\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout.trim();
}

function readLog(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function verifyFixtures() {
  const patch = fs.readFileSync(path.join(fixtures, 'probe.cordis.patch.yml'), 'utf8');
  const plugin = fs.readFileSync(path.join(fixtures, 'probe-plugin.mjs'), 'utf8');
  assert.equal(contract.host.version, '0.1.1-rc.2');
  assert.equal(contract.host.gitRevision.length, 40);
  assert.deepEqual(contract.invocation.headless, ['--profile', 'headless', '<task>']);
  assert.match(patch, /name: '@deepseek-ai\/dsh-mcp-client'/);
  assert.match(patch, /transport: stdio/);
  assert.match(patch, /failOnStartupError: true/);
  assert.match(patch, /enabled: false/);
  assert.match(plugin, /'session\/flush'/);
  for (const event of contract.events.lifecycle) assert.match(plugin, new RegExp(event.replace('/', '\\/')));
  for (const event of contract.events.toolPipeline) assert.match(plugin, new RegExp(event.replace('/', '\\/')));
}

function liveProbe(source) {
  const packageJson = JSON.parse(fs.readFileSync(path.join(source, 'package.json'), 'utf8'));
  const revision = command('git', ['rev-parse', 'HEAD'], { cwd: source });
  assert.equal(packageJson.version, contract.host.version);
  assert.equal(packageJson.engines.node, contract.host.nodeEngine);
  assert.equal(revision, contract.host.gitRevision);

  const runDir = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-dsh-contract-'));
  const receiptPath = path.join(runDir, 'probe-receipt.json');
  const mcpLogPath = path.join(runDir, 'mcp.jsonl');
  const patchPath = path.join(runDir, 'probe.cordis.patch.yml');
  const patchTemplate = fs.readFileSync(path.join(fixtures, 'probe.cordis.patch.yml'), 'utf8');
  fs.writeFileSync(patchPath, patchTemplate.replace(
    '__ZONOID_DSH_PROBE_PLUGIN__',
    JSON.stringify(pathToFileURL(path.join(fixtures, 'probe-plugin.mjs')).href),
  ));
  const dshBin = path.join(source, 'apps', 'cli', 'lib', 'bin.js');
  assert.ok(fs.existsSync(dshBin), 'build the pinned checkout with `pnpm run build:lib` before probing');
  const dsh = args => command(process.execPath, [dshBin, ...args], {
    cwd: root,
    env,
  });
  const env = {
    ...process.env,
    DSH_HOME: path.join(runDir, 'dsh-home'),
    DSH_TELEMETRY_DISABLED: '1',
    DEEPSEEK_API_KEY: 'contract-probe-does-not-call-model',
    ZONOID_DSH_MCP_ENTRY: path.join(fixtures, 'fake-mcp-server.mjs'),
    ZONOID_DSH_MCP_LOG: mcpLogPath,
    ZONOID_DSH_WORKSPACE: root,
    ZONOID_DSH_PROBE_RECEIPT: receiptPath,
  };

  try {
    const version = dsh(['--version']);
    assert.equal(version, contract.host.version);
    const dump = dsh([
      '--profile', 'headless', '--patch', patchPath, '--dump-config',
    ]);
    assert.match(dump, /zonoid-contract-mcp/);
    assert.match(dump, /zonoid-host-contract-probe/);

    dsh([
      '--profile', 'headless', '--patch', patchPath, 'contract probe',
    ]);
    const receipt = JSON.parse(fs.readFileSync(receiptPath, 'utf8'));
    const mcpLog = readLog(mcpLogPath);
    assert.equal(receipt.error, undefined);
    assert.equal(receipt.identity.agentId, receipt.identity.sessionId);
    assert.equal(receipt.identity.cwd, receipt.identity.canonicalCwd);
    assert.equal(receipt.results.allow.isError, false);
    assert.match(receipt.results.allow.content[0].text, /pong:allow/);
    assert.equal(receipt.results.deny.isError, true);
    assert.match(receipt.results.deny.content[0].text, /contract pre-deny/);
    assert.equal(receipt.results.postBlock.isError, true);
    assert.match(receipt.results.postBlock.content[0].text, /contract post-block/);
    assert.equal(receipt.teardown.pluginDisposed, true);
    assert.equal(mcpLog.filter(event => event.method === 'tools/call').length, 2);
    assert.equal(mcpLog.at(-1).method, 'stdio/eof');

    return {
      host: { version, revision, node: process.version },
      invocation: { profile: 'headless', patch: true, dumpConfig: true },
      identity: { agentIdEqualsSessionId: true, cwdCanonical: true },
      blocking: { allowSucceeded: true, preDenySkippedBody: true, postBlockReturnedError: true },
      lifecycle: receipt.lifecycle.map(event => event.replace(/:session-zonoid-contract$/, '')),
      toolPipeline: receipt.toolPipeline,
      mcp: {
        publicTool: 'mcp__zonoid__contract_ping',
        requests: mcpLog.map(event => event.method),
        toolCallCount: 2,
      },
      teardown: { pluginDisposed: true, mcpStdioClosed: true },
    };
  } finally {
    fs.rmSync(runDir, { recursive: true, force: true });
  }
}

verifyFixtures();
const sourceIndex = process.argv.indexOf('--dsh-source');
if (sourceIndex === -1) {
  console.log('DSH host-contract fixtures verified');
} else {
  const source = path.resolve(process.argv[sourceIndex + 1]);
  console.log(JSON.stringify(liveProbe(source), null, 2));
}
