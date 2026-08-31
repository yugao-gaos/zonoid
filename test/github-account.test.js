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

  // Pin the platform: without it this case silently asserts the POSIX branch only on a POSIX host.
  assert.equal(githubAccount.resolveGhExecutable({
    env: {},
    platform: 'darwin',
    existsSync: (candidate) => candidate === '/opt/homebrew/bin/gh',
  }), '/opt/homebrew/bin/gh');

  const windowsGh = 'C:\\Program Files\\GitHub CLI\\gh.exe';
  assert.equal(githubAccount.resolveGhExecutable({
    env: { ProgramFiles: 'C:\\Program Files' },
    platform: 'win32',
    existsSync: (candidate) => candidate === windowsGh,
  }), windowsGh);

  // winget is the common Windows install today and only leaves a shim under LOCALAPPDATA — an empty
  // ProgramFiles\GitHub CLI must not stop resolution from finding it.
  const wingetGh = 'C:\\Users\\dev\\AppData\\Local\\Microsoft\\WinGet\\Links\\gh.exe';
  assert.equal(githubAccount.resolveGhExecutable({
    env: { ProgramFiles: 'C:\\Program Files', LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
    platform: 'win32',
    existsSync: (candidate) => candidate === wingetGh,
  }), wingetGh);

  const userMsiGh = 'C:\\Users\\dev\\AppData\\Local\\Programs\\GitHub CLI\\gh.exe';
  assert.equal(githubAccount.resolveGhExecutable({
    env: { LOCALAPPDATA: 'C:\\Users\\dev\\AppData\\Local' },
    platform: 'win32',
    existsSync: (candidate) => candidate === userMsiGh,
  }), userMsiGh);

  assert.equal(githubAccount.resolveGhExecutable({
    env: {},
    platform: 'win32',
    existsSync: () => false,
  }), 'gh.exe');
});

test('Git credential helper finds the scoped GitHub CLI under a restricted PATH', {
  skip: process.platform === 'win32',
}, () => {
  const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'github-owner-helper-')));
  const bin = path.join(root, 'bin');
  const fakeGh = path.join(bin, 'gh');
  fs.mkdirSync(bin);
  fs.writeFileSync(fakeGh, [
    '#!/bin/sh',
    'if [ "$1" = "auth" ] && [ "$2" = "token" ]; then',
    '  printf "owner-token\\n"',
    'elif [ "$1" = "auth" ] && [ "$2" = "git-credential" ] && [ "$3" = "get" ]; then',
    '  cat >/dev/null',
    '  printf "protocol=https\\nhost=github.com\\nusername=x-access-token\\npassword=owner-token\\n"',
    'else',
    '  exit 2',
    'fi',
    '',
  ].join('\n'));
  fs.chmodSync(fakeGh, 0o755);

  try {
    const scope = githubAccount.scopeForRemoteSync('https://github.com/repo-owner/widgets.git', {
      env: { PATH: '/usr/bin:/bin' },
      ghExecutable: fakeGh,
    });
    assert.equal(scope.env.PATH, `${bin}${path.delimiter}/usr/bin:/bin`);
    assert.equal(process.env.PATH.includes(bin), false);

    const output = execFileSync('git', githubAccount.gitArgs(scope, ['credential', 'fill']), {
      encoding: 'utf8',
      env: scope.env,
      input: 'protocol=https\nhost=github.com\n\n',
    });
    assert.match(output, /username=x-access-token/);
    assert.match(output, /password=owner-token/);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
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
