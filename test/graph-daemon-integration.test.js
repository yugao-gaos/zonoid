'use strict';

const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const headlessDrain = require('../lib/headless-drain');
const { createGraphAutoflush } = require('../lib/graph-autoflush');

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function rawGit(args) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function identity(repo) {
  git(repo, ['config', 'user.name', 'graph integration']);
  git(repo, ['config', 'user.email', 'graph@example.test']);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makeSubmoduleRepo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-daemon-integration-'));
  const remote = path.join(root, 'graph.git');
  const graphSource = path.join(root, 'graph-source');
  const superproject = path.join(root, 'superproject');
  rawGit(['init', '--bare', '--initial-branch', 'main', remote]);
  fs.mkdirSync(graphSource);
  rawGit(['init', '--initial-branch', 'main', graphSource]);
  identity(graphSource);
  fs.writeFileSync(path.join(graphSource, 'state.jsonl'), '{"evt":"init"}\n');
  git(graphSource, ['add', '.']);
  git(graphSource, ['commit', '-m', 'graph init']);
  git(graphSource, ['remote', 'add', 'origin', remote]);
  git(graphSource, ['push', '-u', 'origin', 'main']);

  fs.mkdirSync(superproject);
  rawGit(['init', '--initial-branch', 'main', superproject]);
  identity(superproject);
  fs.writeFileSync(path.join(superproject, 'source.txt'), 'superproject\n');
  git(superproject, ['add', '.']);
  git(superproject, ['commit', '-m', 'super init']);
  rawGit(['-C', superproject, '-c', 'protocol.file.allow=always', 'submodule', 'add', '-b', 'main', remote, '.graph']);
  git(superproject, ['commit', '-am', 'attach graph submodule']);
  return { root, remote, graphSource, superproject };
}

test('submodule drain flush leaves superproject HEAD and index unchanged', async () => {
  const fixture = makeSubmoduleRepo();
  try {
    const beforeHead = git(fixture.superproject, ['rev-parse', 'HEAD']);
    const beforeIndex = fs.readFileSync(path.join(fixture.superproject, '.git', 'index'));
    fs.writeFileSync(path.join(fixture.superproject, '.graph', 'durable.jsonl'), '{"evt":"drain"}\n');

    const result = await headlessDrain.commitGraphSnapshot(fixture.superproject, 'integration drain');

    assert.equal(result.status, 'pushed');
    assert.equal(git(fixture.superproject, ['rev-parse', 'HEAD']), beforeHead);
    assert.deepEqual(fs.readFileSync(path.join(fixture.superproject, '.git', 'index')), beforeIndex);
    assert.equal(git(fixture.superproject, ['status', '--porcelain']), 'M .graph');
    assert.match(git(path.join(fixture.superproject, '.graph'), ['log', '-1', '--pretty=%s']), /integration drain/);
  } finally {
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

test('autoflush coalesces changes per graph repository', async () => {
  const calls = [];
  const service = createGraphAutoflush({
    delayMs: 10,
    retryMs: 20,
    graphRepo: { flush: async (repoRoot) => { calls.push(repoRoot); return { status: 'pushed' }; } },
  });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-autoflush-coalesce-'));
  try {
    service.schedule(repo);
    service.notifyChange(repo);
    service.notifyChange(repo);
    await wait(40);
    assert.equal(calls.length, 1);
    assert.equal(service.status(repo).pending, false);
  } finally {
    service.stop();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('autoflush keeps two graph repositories isolated', async () => {
  const calls = [];
  const service = createGraphAutoflush({
    graphRepo: { flush: async (repoRoot) => { calls.push(repoRoot); return { status: 'pushed' }; } },
  });
  const left = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-autoflush-left-'));
  const right = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-autoflush-right-'));
  try {
    await Promise.all([service.flushNow(left), service.flushNow(right)]);
    assert.deepEqual(new Set(calls), new Set([fs.realpathSync(left), fs.realpathSync(right)]));
  } finally {
    service.stop();
    fs.rmSync(left, { recursive: true, force: true });
    fs.rmSync(right, { recursive: true, force: true });
  }
});

test('autoflush retains offline pending work and retries on its timer', async () => {
  let attempts = 0;
  const service = createGraphAutoflush({
    delayMs: 5,
    retryMs: 10,
    graphRepo: { flush: async () => (++attempts === 1 ? { status: 'pending', error: 'offline' } : { status: 'pushed' }) },
  });
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-autoflush-offline-'));
  try {
    const first = await service.flushNow(repo);
    assert.equal(first.status, 'pending');
    assert.equal(service.status(repo).pending, true);
    await wait(35);
    assert.equal(attempts, 2);
    assert.equal(service.status(repo).pending, false);
  } finally {
    service.stop();
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('ordinary graph snapshot keeps superproject fallback behavior', async () => {
  const repo = fs.mkdtempSync(path.join(os.tmpdir(), 'graph-daemon-ordinary-'));
  try {
    rawGit(['init', '--initial-branch', 'main', repo]);
    identity(repo);
    fs.mkdirSync(path.join(repo, '.graph'));
    fs.writeFileSync(path.join(repo, '.graph', 'state.jsonl'), '{"evt":"init"}\n');
    git(repo, ['add', '.']);
    git(repo, ['commit', '-m', 'init']);
    const before = git(repo, ['rev-parse', 'HEAD']);
    fs.appendFileSync(path.join(repo, '.graph', 'state.jsonl'), '{"evt":"drain"}\n');

    const result = await headlessDrain.commitGraphSnapshot(repo, 'ordinary drain');

    assert.equal(result.committed, true);
    assert.notEqual(git(repo, ['rev-parse', 'HEAD']), before);
    assert.match(git(repo, ['log', '-1', '--pretty=%s']), /ordinary drain/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
