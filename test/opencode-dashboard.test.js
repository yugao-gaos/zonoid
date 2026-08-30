#!/usr/bin/env node
'use strict';

const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const {
  dashboardOpen,
  openExternal,
  openerCommand,
} = require('../packages/opencode-plugin/lib/dashboard');
const { installOpencodeDashboardCommand, wireHarness } = require('../packages/cli/bin/zonoid');

function spawningMock(event, calls) {
  return (command, args, options) => {
    calls.push({ command, args, options });
    const child = new EventEmitter();
    child.unref = () => { child.unrefCalled = true; };
    process.nextTick(() => child.emit(event, event === 'error' ? new Error('no browser') : undefined));
    return child;
  };
}

test('OpenCode dashboard uses shared scoped launch contract without a token', async () => {
  const workspace = '/repo/app with spaces';
  const result = await dashboardOpen({
    workspace,
    origin: 'https://dashboard.example.test',
    open: false,
  });
  assert.equal(result.ok, true);
  assert.equal(result.launch.workspace, workspace);
  assert.equal(result.launch.viewer, 'opencode');
  assert.equal(result.launch.url, `https://dashboard.example.test/graph?workspace=${encodeURIComponent(workspace)}&viewer=opencode`);
  assert.equal(result.launch.resource_uri, 'ui://orchestrator/graph');
  assert.deepEqual(result.opened, { ok: false, skipped: true });
  assert.ok(!result.launch.url.includes('token'));
});

test('OpenCode dashboard inherits shared origin validation', async () => {
  await assert.rejects(
    dashboardOpen({ workspace: '/repo/app', origin: 'https://user:secret@example.test', open: false }),
    /credentials/,
  );
});

test('browser opener uses platform argv without shell interpolation', () => {
  assert.deepEqual(openerCommand('https://example.test/a?b=1', 'darwin'), {
    command: 'open', args: ['https://example.test/a?b=1'],
  });
  assert.deepEqual(openerCommand('https://example.test/a?b=1', 'linux'), {
    command: 'xdg-open', args: ['https://example.test/a?b=1'],
  });
  assert.deepEqual(openerCommand('https://example.test/a?b=1', 'win32'), {
    command: 'cmd', args: ['/c', 'start', '', 'https://example.test/a?b=1'],
  });
});

test('browser opener reports success and failure without losing descriptor', async () => {
  const calls = [];
  const success = await openExternal('https://example.test', {
    platform: 'linux', spawnImpl: spawningMock('spawn', calls),
  });
  assert.equal(success.ok, true);
  assert.equal(calls[0].options.detached, true);
  assert.equal(calls[0].options.stdio, 'ignore');

  const failed = await dashboardOpen({
    workspace: '/repo/app',
    open: true,
    opener: async () => ({ ok: false, error: 'no browser' }),
  });
  assert.equal(failed.ok, true);
  assert.equal(failed.opened.ok, false);
  assert.match(failed.launch.url, /workspace=%2Frepo%2Fapp/);

  const openFailure = await openExternal('https://example.test', {
    platform: 'linux', spawnImpl: spawningMock('error', []),
  });
  assert.equal(openFailure.ok, false);
  assert.equal(openFailure.error, 'no browser');
});

test('OpenCode /dashboard command install is idempotent and preserves user files', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-opencode-dashboard-'));
  try {
    const first = installOpencodeDashboardCommand(temp);
    assert.equal(first.ok, true);
    assert.equal(first.installed, true);
    const command = path.join(temp, '.opencode', 'commands', 'dashboard.md');
    const installed = fs.readFileSync(command, 'utf8');
    // Frontmatter must open the file. Match the delimiter line rather than a literal '---\n': the
    // installer copies the source command byte-for-byte, and under core.autocrlf the checked-out
    // source starts '---\r\n' — a checkout artifact, not a missing frontmatter block.
    assert.match(installed, /^---\r?\n/);
    assert.match(installed, /dashboard_open/);

    const second = installOpencodeDashboardCommand(temp);
    assert.equal(second.current, true);
    assert.equal(fs.readFileSync(command, 'utf8'), installed);

    fs.writeFileSync(command, installed.replace('Call the `dashboard_open` tool', 'Old managed command'));
    const upgraded = installOpencodeDashboardCommand(temp);
    assert.equal(upgraded.installed, true);
    assert.equal(fs.readFileSync(command, 'utf8'), installed);

    fs.writeFileSync(command, 'user command\n');
    const preserved = installOpencodeDashboardCommand(temp);
    assert.equal(preserved.reason, 'user_owned');
    assert.equal(fs.readFileSync(command, 'utf8'), 'user command\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('OpenCode harness wiring creates and preserves the project /dashboard command', () => {
  const temp = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-opencode-wire-'));
  try {
    fs.mkdirSync(path.join(temp, '.opencode', 'node_modules', '@opencode-ai', 'plugin'), { recursive: true });
    fs.writeFileSync(path.join(temp, '.opencode', 'node_modules', '@opencode-ai', 'plugin', 'package.json'), '{}\n');
    wireHarness('opencode', temp);
    const command = path.join(temp, '.opencode', 'commands', 'dashboard.md');
    assert.match(fs.readFileSync(command, 'utf8'), /dashboard_open/);

    fs.writeFileSync(command, 'user dashboard command\n');
    wireHarness('opencode', temp);
    assert.equal(fs.readFileSync(command, 'utf8'), 'user dashboard command\n');
  } finally {
    fs.rmSync(temp, { recursive: true, force: true });
  }
});

test('stable OpenCode plugin exposes dashboard_open', () => {
  const source = fs.readFileSync(path.join(__dirname, '..', 'packages', 'opencode-plugin', 'zonoid.ts'), 'utf8');
  assert.match(source, /dashboard_open:\s*tool\(/);
  assert.match(source, /dashboardOpen\(/);
});
