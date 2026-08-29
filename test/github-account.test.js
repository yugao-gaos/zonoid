#!/usr/bin/env node
'use strict';

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const test = require('node:test');
const { execFileSync } = require('child_process');

const githubAccount = require('../lib/github-account');
const gitClaims = require('../lib/git-claims');
const graphRepo = require('../lib/graph-repo');

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim();
}

test('derives GitHub owner from HTTPS and SSH remotes', () => {
  assert.deepEqual(githubAccount.parseRemote('https://github.com/acme/widgets.git'), {
    host: 'github.com', owner: 'acme', repo: 'widgets',
  });
  assert.deepEqual(githubAccount.parseRemote('git@github.com:octo-org/service.git'), {
    host: 'github.com', owner: 'octo-org', repo: 'service',
  });
  assert.deepEqual(githubAccount.parseRemote('ssh://git@github.com/other/repo'), {
    host: 'github.com', owner: 'other', repo: 'repo',
  });
});

test('resolves GitHub CLI outside an interactive PATH', () => {
  assert.equal(githubAccount.resolveGhExecutable({
    env: { ZONOID_GH_PATH: '/custom/bin/gh' },
    existsSync: () => false,
  }), '/custom/bin/gh');

  assert.equal(githubAccount.resolveGhExecutable({
    env: {},
    existsSync: (candidate) => candidate === '/opt/homebrew/bin/gh',
  }), '/opt/homebrew/bin/gh');
});

test('non-GitHub remotes bypass account lookup and remain unchanged', async () => {
  let calls = 0;
  const value = await githubAccount.withOwnerCredential('https://gitlab.com/acme/widgets.git', async (scope) => {
    assert.equal(scope, null);
    return 'unchanged';
  }, {
    runGh: async () => { calls++; throw new Error('must not run'); },
  });
  assert.equal(value, 'unchanged');
  assert.equal(calls, 0);
});

test('owner token is scoped to the operation without changing the active account on success', async () => {
  const originalGhToken = process.env.GH_TOKEN;
  let activeAccount = 'normal-user';
  const commands = [];
  const result = await githubAccount.withOwnerCredential('https://github.com/repo-owner/widgets.git', async (scope) => {
    assert.equal(activeAccount, 'normal-user');
    assert.equal(scope.owner, 'repo-owner');
    assert.equal(scope.env.GH_TOKEN, 'owner-secret-token');
    assert.equal(scope.env.GITHUB_TOKEN, 'owner-secret-token');
    assert(scope.gitArgs.includes('url.https://github.com/.insteadOf=git@github.com:'));
    return 'pushed';
  }, {
    runGh: async (args) => {
      commands.push(args);
      return 'owner-secret-token\n';
    },
  });

  assert.equal(result, 'pushed');
  assert.equal(activeAccount, 'normal-user');
  assert.equal(process.env.GH_TOKEN, originalGhToken);
  assert.deepEqual(commands, [[
    'auth', 'token', '--hostname', 'github.com', '--user', 'repo-owner',
  ]]);
});

test('active account stays unchanged and token stays out of errors when the operation fails', async () => {
  const originalGhToken = process.env.GH_TOKEN;
  let activeAccount = 'normal-user';
  await assert.rejects(
    githubAccount.withOwnerCredential('git@github.com:repo-owner/widgets.git', async (scope) => {
      assert.equal(scope.env.GH_TOKEN, 'owner-secret-token');
      throw new Error('push rejected');
    }, {
      runGh: async () => 'owner-secret-token',
    }),
    /push rejected/
  );
  assert.equal(activeAccount, 'normal-user');
  assert.equal(process.env.GH_TOKEN, originalGhToken);
});

test('missing owner authentication fails before the operation with a sanitized message', async () => {
  let operated = false;
  await assert.rejects(
    githubAccount.withOwnerCredential('https://github.com/missing-owner/widgets.git', async () => {
      operated = true;
    }, {
      runGh: async () => { throw new Error('credential contained secret-token-value'); },
    }),
    (error) => {
      assert.equal(error.code, 'github_owner_not_authenticated');
      assert.match(error.message, /missing-owner/);
      assert.doesNotMatch(error.message, /secret-token-value/);
      return true;
    }
  );
  assert.equal(operated, false);
});

test('sync scope uses the same owner-specific credential and SSH rewrite', () => {
  let activeAccount = 'normal-user';
  const result = githubAccount.withOwnerCredentialSync('ssh://git@github.com/repo-owner/widgets.git', (scope) => {
    assert.equal(scope.owner, 'repo-owner');
    assert.equal(scope.env.GH_TOKEN, 'sync-owner-token');
    assert(scope.gitArgs.includes('url.https://github.com/.insteadOf=ssh://git@github.com/'));
    return 'ok';
  }, {
    runGhSync: () => 'sync-owner-token\n',
  });
  assert.equal(result, 'ok');
  assert.equal(activeAccount, 'normal-user');
});

test('Git claim push fails before mutation when the remote owner is not authenticated', () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'github-owner-claim-')));
  try {
    execFileSync('git', ['init', '--initial-branch', 'main', repo], { stdio: 'ignore' });
    execFileSync('git', ['-C', repo, 'config', 'user.name', 'Test User']);
    execFileSync('git', ['-C', repo, 'config', 'user.email', 'test@example.test']);
    execFileSync('git', ['-C', repo, 'remote', 'add', 'origin', 'https://github.com/missing-owner/repo.git']);
    const result = gitClaims.acquire(repo, 'task/not-authenticated', {
      gitUser: 'Test User <test@example.test>',
      sessionId: 'session-1',
      githubAccount: { runGhSync: () => { throw new Error('secret-token-value'); } },
    });
    assert.equal(result.ok, false);
    assert.equal(result.code, 'github_owner_not_authenticated');
    assert.doesNotMatch(result.error, /secret-token-value/);
    assert.equal(fs.existsSync(path.join(repo, '.graph', 'claims')), false);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});

test('graph flush preserves its local commit when owner authentication is unavailable', async () => {
  const repo = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'github-owner-graph-')));
  const graph = path.join(repo, '.graph');
  try {
    execFileSync('git', ['init', '--initial-branch', 'main', repo], { stdio: 'ignore' });
    execFileSync('git', ['init', '--initial-branch', 'main', graph], { stdio: 'ignore' });
    git(graph, ['config', 'user.name', 'Graph Test']);
    git(graph, ['config', 'user.email', 'graph@example.test']);
    fs.writeFileSync(path.join(graph, 'seed.jsonl'), '{}\n');
    git(graph, ['add', 'seed.jsonl']);
    git(graph, ['commit', '-m', 'seed']);
    git(graph, ['remote', 'add', 'origin', 'https://github.com/missing-owner/repo-graph.git']);
    const before = git(graph, ['rev-parse', 'HEAD']);
    fs.writeFileSync(path.join(graph, 'new.jsonl'), '{"new":true}\n');

    const result = await graphRepo.flush(repo, {
      push: true,
      retries: 0,
      githubAccount: { runGh: async () => { throw new Error('secret-token-value'); } },
    });
    const after = git(graph, ['rev-parse', 'HEAD']);
    assert.equal(result.status, 'pending');
    assert.equal(result.attempts, 0);
    assert.notEqual(after, before);
    assert.match(result.error, /missing-owner/);
    assert.doesNotMatch(result.error, /secret-token-value/);
  } finally {
    fs.rmSync(repo, { recursive: true, force: true });
  }
});
