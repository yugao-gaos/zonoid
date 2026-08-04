#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

const graphRepo = require('../lib/graph-repo');

let pass = 0;
let fail = 0;
const cleanupPaths = [];

function ok(label, condition, detail) {
  if (condition) {
    console.log(`PASS  ${label}`);
    pass++;
    return;
  }
  console.log(`FAIL  ${label}${detail ? ` (${detail})` : ''}`);
  fail++;
}

function git(cwd, args, options = {}) {
  return execFileSync('git', ['-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function rawGit(args, options = {}) {
  return execFileSync('git', args, {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    ...options,
  }).trim();
}

function writeFile(file, contents) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, contents);
}

function tempDir(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanupPaths.push(dir);
  return dir;
}

function setIdentity(repo) {
  git(repo, ['config', 'user.name', 'Graph Repo Test']);
  git(repo, ['config', 'user.email', 'graph-repo@example.test']);
}

function initBareRemote(branch = 'main') {
  const bare = path.join(tempDir('graph-repo-remote-'), 'remote.git');
  rawGit(['init', '--bare', '--initial-branch', branch, bare]);

  const seed = tempDir('graph-repo-seed-');
  rawGit(['init', '--initial-branch', branch, seed]);
  setIdentity(seed);
  writeFile(path.join(seed, 'seed.txt'), `${branch}\n`);
  git(seed, ['add', 'seed.txt']);
  git(seed, ['commit', '-m', 'seed']);
  git(seed, ['remote', 'add', 'origin', bare]);
  git(seed, ['push', '-u', 'origin', branch]);

  return { bare, branch };
}

function createSubmoduleRepo(remote) {
  const repoRoot = tempDir('graph-repo-root-');
  rawGit(['init', '--initial-branch', 'main', repoRoot]);
  setIdentity(repoRoot);
  rawGit(['-C', repoRoot, '-c', 'protocol.file.allow=always', 'submodule', 'add', remote, '.graph']);
  setIdentity(path.join(repoRoot, '.graph'));
  return { repoRoot, graphDir: path.join(repoRoot, '.graph') };
}

function headSubject(repo) {
  return git(repo, ['log', '-1', '--pretty=%s']);
}

function gitPath(repo, relativePath) {
  return git(repo, ['rev-parse', '--path-format=absolute', '--git-path', relativePath]);
}

function shQuote(value) {
  return `'${String(value).replace(/'/g, `'\"'\"'`)}'`;
}

async function testOrdinaryNoop() {
  const missingRoot = tempDir('graph-repo-missing-');
  ok('detect missing repoRoot', graphRepo.detect(missingRoot) === 'missing', graphRepo.detect(missingRoot));

  const ordinaryRoot = tempDir('graph-repo-ordinary-');
  fs.mkdirSync(path.join(ordinaryRoot, '.graph'), { recursive: true });
  writeFile(path.join(ordinaryRoot, '.graph', 'state.json'), '{}\n');

  ok('detect ordinary graph repo', graphRepo.detect(ordinaryRoot) === 'ordinary', graphRepo.detect(ordinaryRoot));
  const flushed = await graphRepo.flush(ordinaryRoot, { message: 'ordinary', push: true });
  ok('ordinary flush is skipped', flushed.status === 'skipped' && flushed.kind === 'ordinary', JSON.stringify(flushed));
  const synced = await graphRepo.sync(ordinaryRoot, { latest: true });
  ok('ordinary sync is skipped', synced.status === 'skipped' && synced.kind === 'ordinary', JSON.stringify(synced));
}

async function testSuccessPushAndSync() {
  const remote = initBareRemote('main');
  const writer = createSubmoduleRepo(remote.bare);
  const follower = createSubmoduleRepo(remote.bare);

  writeFile(path.join(writer.graphDir, 'writer.txt'), 'writer change\n');
  const flushed = await graphRepo.flush(writer.repoRoot, { message: 'writer flush', push: true, retries: 1 });
  ok('submodule flush pushes successfully', flushed.status === 'pushed' && flushed.branch === 'main', JSON.stringify(flushed));
  const attributes = fs.readFileSync(path.join(writer.graphDir, '.gitattributes'), 'utf8');
  ok('graph repo installs collaborative merge policy', attributes.includes('*.jsonl merge=union')
    && attributes.includes('checkpoint.json merge=ours'));
  ok('ensureRemoteCommit sees pushed commit', await graphRepo.ensureRemoteCommit(writer.repoRoot, flushed.commit) === true);

  const synced = await graphRepo.sync(follower.repoRoot, { latest: true });
  ok('sync updates follower clone', synced.status === 'synced' && fs.existsSync(path.join(follower.graphDir, 'writer.txt')), JSON.stringify(synced));
  ok('remote head has writer commit', headSubject(remote.bare) === 'writer flush', headSubject(remote.bare));
}

async function testOfflinePreservation() {
  const remote = initBareRemote('main');
  const repo = createSubmoduleRepo(remote.bare);
  const offlineBare = `${remote.bare}.offline`;
  fs.renameSync(remote.bare, offlineBare);
  cleanupPaths.push(offlineBare);

  const before = git(repo.graphDir, ['rev-parse', 'HEAD']);
  writeFile(path.join(repo.graphDir, 'offline.txt'), 'offline change\n');
  const flushed = await graphRepo.flush(repo.repoRoot, { message: 'offline flush', push: true, retries: 1 });
  const after = git(repo.graphDir, ['rev-parse', 'HEAD']);

  ok('offline flush keeps local commit and reports pending', flushed.status === 'pending' && before !== after, JSON.stringify(flushed));
  ok('offline flush returns an error string', typeof flushed.error === 'string' && flushed.error.length > 0, String(flushed.error));
  ok('offline commit remains local only', await graphRepo.ensureRemoteCommit(repo.repoRoot, after) === false);
}

async function testTwoCloneConvergenceRetry() {
  const remote = initBareRemote('main');
  const left = createSubmoduleRepo(remote.bare);
  const right = createSubmoduleRepo(remote.bare);

  writeFile(path.join(left.graphDir, 'left.txt'), 'left change\n');
  const localOnly = await graphRepo.flush(left.repoRoot, { message: 'left local', push: false });
  ok('left clone creates a local commit before the race', localOnly.status === 'pending', JSON.stringify(localOnly));

  writeFile(path.join(right.graphDir, 'right.txt'), 'right change\n');
  const marker = path.join(tempDir('graph-repo-hook-'), 'pre-push.marker');
  const hookFile = gitPath(right.graphDir, 'hooks/pre-push');
  writeFile(hookFile, [
    '#!/bin/sh',
    'set -eu',
    `marker=${shQuote(marker)}`,
    'if [ ! -f "$marker" ]; then',
    '  touch "$marker"',
    '  for name in $(git rev-parse --local-env-vars); do',
    '    unset "$name"',
    '  done',
    `  git -C ${shQuote(left.graphDir)} push origin HEAD:refs/heads/main`,
    'fi',
    'exit 0',
    '',
  ].join('\n'));
  fs.chmodSync(hookFile, 0o755);

  const flushed = await graphRepo.flush(right.repoRoot, { message: 'right push', push: true, retries: 2 });
  ok('right clone retries and eventually pushes', flushed.status === 'pushed' && flushed.attempts === 2, JSON.stringify(flushed));
  ok('right clone converges left commit after retry', fs.existsSync(path.join(right.graphDir, 'left.txt')), 'left.txt missing after retry');
  const log = git(remote.bare, ['log', '--pretty=%s']);
  ok('remote history contains both commits', /right push/.test(log) && /left local/.test(log), log);
}

async function testDetachedHeadAttach() {
  const remote = initBareRemote('trunk');
  const repo = createSubmoduleRepo(remote.bare);

  const start = git(repo.graphDir, ['rev-parse', 'HEAD']);
  git(repo.graphDir, ['checkout', start]);
  ok('graph clone is detached before flush', git(repo.graphDir, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'HEAD');

  writeFile(path.join(repo.graphDir, 'detached.txt'), 'detached change\n');
  const flushed = await graphRepo.flush(repo.repoRoot, { message: 'detached flush', push: true, retries: 1 });
  ok('detached head attaches to remote default branch', flushed.status === 'pushed' && flushed.branch === 'trunk', JSON.stringify(flushed));
  ok('branch stays attached after flush', git(repo.graphDir, ['rev-parse', '--abbrev-ref', 'HEAD']) === 'trunk', git(repo.graphDir, ['rev-parse', '--abbrev-ref', 'HEAD']));
}

async function testSerializationAfterRejection() {
  const repoRoot = tempDir('graph-repo-serialize-');
  const order = [];
  const first = graphRepo.serialize(repoRoot, async () => {
    order.push('first');
    throw new Error('boom');
  });
  const second = graphRepo.serialize(repoRoot, async () => {
    order.push('second');
    return 'ok';
  });
  let rejected = false;
  try {
    await first;
  } catch (error) {
    rejected = error.message === 'boom';
  }
  const value = await second;
  ok('serialize preserves the rejection reason', rejected === true);
  ok('serialize chain survives rejection', value === 'ok' && order.join(',') === 'first,second', order.join(','));
}

async function main() {
  try {
    await testOrdinaryNoop();
    await testSuccessPushAndSync();
    await testOfflinePreservation();
    await testTwoCloneConvergenceRetry();
    await testDetachedHeadAttach();
    await testSerializationAfterRejection();
  } finally {
    for (const target of cleanupPaths.reverse()) {
      fs.rmSync(target, { recursive: true, force: true });
    }
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
