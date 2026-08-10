#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const { startWorkspaceOnboarding } = require('../packages/cli/bin/zonoid');
const onboardRoute = require('../routes/onboard');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8', windowsHide: true }).trim();
}

function routePost(calls) {
  return async (route, body) => {
    calls.push({ route, body });
    let response = null;
    const handler = onboardRoute({
      readBody: async () => body,
      send: (_res, status, payload) => { response = { status, payload }; },
      notifyChange: () => {},
    });
    const handled = await handler(route, 'POST', {}, {}, new URL(`http://localhost${route}`));
    assert.equal(handled, true);
    assert.ok(response);
    return response.payload;
  };
}

test('init lifecycle arms onboarding without a dashboard and leaves accumulated project work untouched', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-auto-onboard-'));
  const source = path.join(repo, 'src', 'feature.js');
  const sourceBody = 'module.exports = function accumulatedWork() { return 42; };\n';
  const calls = [];

  try {
    fs.mkdirSync(path.dirname(source), { recursive: true });
    fs.writeFileSync(source, sourceBody);
    fs.writeFileSync(path.join(repo, 'README.md'), '# Existing project\n\nSeveral work sessions already happened here.\n');
    fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ name: 'existing-project', version: '1.0.0' }, null, 2));
    git(repo, ['init']);
    git(repo, ['config', 'user.name', 'test']);
    git(repo, ['config', 'user.email', 'test@example.com']);
    git(repo, ['add', '-A']);
    git(repo, ['commit', '-m', 'accumulated project work']);
    const headBefore = git(repo, ['rev-parse', 'HEAD']);

    const result = await startWorkspaceOnboarding(repo, {
      post: routePost(calls),
    });

    assert.equal(result.ok, true);
    assert.deepEqual(calls.map((call) => call.route), ['/onboard/enqueue', '/onboard/drain-queue']);
    assert.deepEqual(calls[0].body, { repo });
    assert.equal(calls[1].body.repo, repo);
    assert.equal(calls[1].body.autoInject, true);
    assert.equal(calls[1].body.liveInject, true);
    const queue = JSON.parse(fs.readFileSync(path.join(result.outDir, 'onboard-queue.json'), 'utf8'));
    const status = JSON.parse(fs.readFileSync(path.join(result.outDir, 'onboard-drain-status.json'), 'utf8'));
    assert.ok(queue.total > 0, 'existing project content must be mined before any dashboard opens');
    assert.equal(status.repo, repo);
    assert.equal(status.autoInject, true);
    assert.equal(fs.readFileSync(source, 'utf8'), sourceBody);
    assert.equal(git(repo, ['rev-parse', 'HEAD']), headBefore);
    assert.equal(git(repo, ['diff', '--', 'src/feature.js']), '');

    const cliSource = fs.readFileSync(path.join(__dirname, '..', 'packages', 'cli', 'bin', 'zonoid.js'), 'utf8');
    const registerAt = cliSource.indexOf('const registeredRepo = await registerWorkspace(cwd, opts.workspace);');
    const onboardAt = cliSource.indexOf('if (registeredRepo) await startWorkspaceOnboarding(registeredRepo);');
    assert.ok(registerAt >= 0 && onboardAt > registerAt, 'init must arm onboarding immediately after registration');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('onboarding startup failure is advisory and does not mutate project files', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-auto-onboard-fail-'));
  const source = path.join(repo, 'work.txt');
  try {
    fs.writeFileSync(source, 'valuable existing work\n');
    const result = await startWorkspaceOnboarding(repo, {
      post: async () => { throw new Error('daemon unavailable'); },
    });
    assert.equal(result.ok, false);
    assert.equal(fs.readFileSync(source, 'utf8'), 'valuable existing work\n');
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
