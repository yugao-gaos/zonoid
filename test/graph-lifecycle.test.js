#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const lifecycle = require('../lib/graph-lifecycle');

let pass = 0;
let fail = 0;
const cleanup = [];

function ok(label, value, detail) {
  if (value) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ` (${detail})` : ''}`);
    fail++;
  }
}

function git(cwd, args) {
  return execFileSync('git', ['-C', cwd, ...args], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function rawGit(args) {
  return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
}

function temp(prefix) {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  cleanup.push(dir);
  return dir;
}

function write(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, value);
}

function identity(repo) {
  git(repo, ['config', 'user.name', 'Lifecycle Test']);
  git(repo, ['config', 'user.email', 'lifecycle@example.test']);
}

function bareRemote() {
  const remote = path.join(temp('graph-lifecycle-remote-'), 'remote.git');
  rawGit(['init', '--bare', '--initial-branch', 'main', remote]);
  return remote;
}

function ordinaryRepo(remote) {
  const repo = temp('graph-lifecycle-repo-');
  rawGit(['init', '--initial-branch', 'main', repo]);
  identity(repo);
  git(repo, ['remote', 'add', 'origin', remote]);
  fs.mkdirSync(path.join(repo, '.graph'), { recursive: true });
  write(path.join(repo, '.graph', 'one.txt'), 'one\n');
  git(repo, ['add', '.graph']);
  git(repo, ['commit', '-m', 'graph one']);
  write(path.join(repo, '.graph', 'two.txt'), 'two\n');
  git(repo, ['add', '.graph']);
  git(repo, ['commit', '-m', 'graph two']);
  return repo;
}

function gitlink(repo) {
  return git(repo, ['ls-files', '--stage', '--', '.graph']).startsWith('160000 ');
}

async function testDerive() {
  ok('derive GitHub HTTPS remote', lifecycle.deriveRemote('https://github.com/acme/zonoid.git') === 'https://github.com/acme/zonoid-graph.git');
  ok('derive GitHub SSH remote', lifecycle.deriveRemote('git@github.com:acme/zonoid.git') === 'https://github.com/acme/zonoid-graph.git');
}

async function testDryRunAndExtraction() {
  const remote = bareRemote();
  const repo = ordinaryRepo(remote);
  const before = git(repo, ['rev-parse', 'HEAD']);
  const dry = await lifecycle.init(repo, { dryRun: true, remote });
  ok('dry run does not mutate', dry.dryRun === true && git(repo, ['rev-parse', 'HEAD']) === before && !gitlink(repo));
  ok('explicit graph remote is used exactly', dry.remote === remote);
  let graph = await lifecycle.init(repo, { yes: true, remote });
  ok('ordinary graph converts to submodule', graph.status === 'initialized' && gitlink(repo));
  ok('extracted graph keeps first history commit', git(path.join(repo, '.graph'), ['log', '--pretty=%s']).includes('graph one'));
  ok('extracted graph keeps second history commit', git(path.join(repo, '.graph'), ['log', '--pretty=%s']).includes('graph two'));
  ok('extracted graph is pushed', await require('../lib/graph-repo').ensureRemoteCommit(repo, graph.graphHead));
}

async function testRollback() {
  const remote = bareRemote();
  const repo = ordinaryRepo(remote);
  const beforeIndex = fs.readFileSync(path.join(repo, '.git', 'index'));
  const beforeGraph = fs.readFileSync(path.join(repo, '.graph', 'one.txt'));
  let thrown = false;
  try {
    await lifecycle.init(repo, {
      yes: true,
      remote,
      failHook(step) {
        if (step === 'after-submodule-add') throw new Error('injected failure');
      },
    });
  } catch (error) {
    thrown = /injected failure/.test(error.message);
  }
  ok('injected failure rejects init', thrown);
  ok('rollback restores ordinary graph', !gitlink(repo) && fs.readFileSync(path.join(repo, '.graph', 'one.txt')).equals(beforeGraph));
  ok('rollback restores index', fs.readFileSync(path.join(repo, '.git', 'index')).equals(beforeIndex));
  ok('rollback removes gitmodules', !fs.existsSync(path.join(repo, '.gitmodules')));
}

async function testDirtyRefusal() {
  const remote = bareRemote();
  const repo = ordinaryRepo(remote);
  write(path.join(repo, 'unrelated.txt'), 'do not convert\n');
  let thrown = false;
  try { await lifecycle.init(repo, { yes: true, remote }); } catch (error) { thrown = /unrelated dirty files/.test(error.message); }
  ok('unrelated dirty files refuse conversion', thrown && !gitlink(repo));
}

async function testReviewFixes() {
  const remote = bareRemote();
  const repo = ordinaryRepo(remote);
  fs.rmSync(path.join(repo, '.graph', 'one.txt'));
  const result = await lifecycle.init(repo, { yes: true, remote });
  ok('conversion mirrors current graph deletions', result.status === 'initialized'
    && !fs.existsSync(path.join(repo, '.graph', 'one.txt'))
    && fs.existsSync(path.join(repo, '.graph', 'two.txt')));

  const source = ordinaryRepo(bareRemote());
  const worktreeRemote = bareRemote();
  const worktree = temp('graph-lifecycle-worktree-');
  fs.rmdirSync(worktree);
  rawGit(['-C', source, 'worktree', 'add', '--detach', worktree]);
  identity(worktree);
  const worktreeResult = await lifecycle.init(worktree, { yes: true, remote: worktreeRemote });
  ok('init resolves worktree git paths', worktreeResult.status === 'initialized' && gitlink(worktree));
}

async function testSyncFlushCheckpointStatus() {
  const remote = bareRemote();
  const repo = ordinaryRepo(remote);
  const converted = await lifecycle.init(repo, { yes: true, remote });
  const graphDir = path.join(repo, '.graph');
  write(path.join(graphDir, 'live.txt'), 'live\n');
  const flushed = await lifecycle.flush(repo, { push: true, message: 'live graph' });
  ok('flush delegates and pushes', flushed.status === 'pushed');
  const before = git(repo, ['rev-parse', 'HEAD']);
  const checkpoint = await lifecycle.checkpoint(repo);
  ok('checkpoint requires remote commit', checkpoint.status === 'staged' && checkpoint.commit === flushed.commit);
  ok('checkpoint does not commit superproject', git(repo, ['rev-parse', 'HEAD']) === before);
  const status = await lifecycle.status(repo);
  ok('status reports submodule mode and graph head', status.mode === 'submodule' && status.graphHead === flushed.commit);
  ok('status reports remote commit', status.ensureRemoteCommit === true);
  ok('status reports staged clean gitlink', status.gitlink.staged === true && status.gitlink.dirty === false);
  ok('init result contains graph head', converted.graphHead && converted.remote === remote);

  git(repo, ['commit', '-m', 'checkpoint superproject']);
  fs.rmSync(path.join(repo, '.graph'), { recursive: true, force: true });
  const synced = await lifecycle.sync(repo, { latest: false });
  ok('sync initializes a missing submodule', synced.status === 'synced' && fs.existsSync(path.join(repo, '.graph', 'one.txt')));
}

async function testFeatureCheckpoint() {
  const remote = bareRemote();
  const repo = ordinaryRepo(remote);
  await lifecycle.init(repo, { yes: true, remote });
  git(repo, ['commit', '-m', 'attach graph submodule']);

  const feature = temp('graph-lifecycle-feature-');
  fs.rmdirSync(feature);
  rawGit(['-C', repo, 'worktree', 'add', '-b', 'feature/checkpoint', feature]);
  identity(feature);
  const mainBefore = git(repo, ['rev-parse', 'HEAD']);
  const featureBefore = git(feature, ['rev-parse', 'HEAD']);
  write(path.join(repo, '.graph', 'feature-state.txt'), 'latest\n');

  const result = await lifecycle.checkpointFeature(repo, feature);
  const featureGraph = git(feature, ['rev-parse', 'HEAD:.graph']);
  ok('feature checkpoint commits only the feature pointer', result.status === 'committed'
    && git(repo, ['rev-parse', 'HEAD']) === mainBefore
    && git(feature, ['rev-parse', 'HEAD']) !== featureBefore);
  ok('feature checkpoint points at pushed graph head', featureGraph === result.graphCommit
    && git(path.join(feature, '.graph'), ['show', `${featureGraph}:feature-state.txt`]) === 'latest');
}

async function main() {
  try {
    await testDerive();
    await testDryRunAndExtraction();
    await testRollback();
    await testDirtyRefusal();
    await testReviewFixes();
    await testSyncFlushCheckpointStatus();
    await testFeatureCheckpoint();
  } finally {
    for (const dir of cleanup.reverse()) fs.rmSync(dir, { recursive: true, force: true });
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
