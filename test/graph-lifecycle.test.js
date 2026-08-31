#!/usr/bin/env node
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');
const lifecycle = require('../lib/graph-lifecycle');
const { hasGitFilterRepo } = require('./helpers/tools');

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
  write(path.join(graphDir, 'after-checkpoint.txt'), 'new live state\n');
  await lifecycle.flush(repo, { push: true, message: 'advance graph after checkpoint' });
  const dirtyStatus = await lifecycle.status(repo);
  ok('status reports an unstaged graph advance', dirtyStatus.gitlink.staged === false && dirtyStatus.gitlink.dirty === true);
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

async function featureCheckpointFixture() {
  const remote = bareRemote();
  const repo = ordinaryRepo(remote);
  await lifecycle.init(repo, { yes: true, remote });
  git(repo, ['commit', '-m', 'attach graph submodule']);
  const feature = temp('graph-lifecycle-feature-blockers-');
  fs.rmdirSync(feature);
  rawGit(['-C', repo, 'worktree', 'add', '-b', `feature/blockers-${path.basename(feature)}`, feature]);
  identity(feature);
  git(feature, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '--', '.graph']);
  return { repo, feature, graphDir: path.join(repo, '.graph'), featureGraph: path.join(feature, '.graph') };
}

function claim(taskKey, status, timestamp, field = 'claimed_at') {
  return JSON.stringify({ task_key: taskKey, status, [field]: timestamp }, null, 2) + '\n';
}

async function testFeatureCheckpointPreservesDominatedClaims() {
  const fixture = await featureCheckpointFixture();
  const terminalPath = 'claims/terminal.json';
  const newerPath = 'claims/team/newer.json';
  const ignoredPath = 'claims/ignored.json';
  const unrelatedPath = 'scratch/local-only.txt';
  const unrelatedIgnoredPath = 'ignored/local-only.txt';
  const localTerminal = claim('task/terminal', 'claimed', '2026-08-30T20:00:00.000Z');
  const localNewer = claim('task/newer', 'claimed', '2026-08-30T20:01:00.000Z');
  const localIgnored = claim('task/ignored', 'claimed', '2026-08-30T20:01:30.000Z');
  write(path.join(fixture.featureGraph, '.gitignore'), `${ignoredPath}\nignored/\n`);
  write(path.join(fixture.featureGraph, terminalPath), localTerminal);
  write(path.join(fixture.featureGraph, newerPath), localNewer);
  write(path.join(fixture.featureGraph, ignoredPath), localIgnored);
  write(path.join(fixture.featureGraph, unrelatedPath), 'preserve me\n');
  write(path.join(fixture.featureGraph, unrelatedIgnoredPath), 'preserve ignored me\n');
  write(path.join(fixture.graphDir, terminalPath), claim('task/terminal', 'tested', '2026-08-30T20:02:00.000Z', 'completed_at'));
  write(path.join(fixture.graphDir, newerPath), claim('task/newer', 'claimed', '2026-08-30T20:03:00.000Z'));
  write(path.join(fixture.graphDir, ignoredPath), claim('task/ignored', 'tested', '2026-08-30T20:03:30.000Z', 'completed_at'));

  const result = await lifecycle.checkpointFeature(fixture.repo, fixture.feature);
  const stash = result.retainedStash;
  ok('feature checkpoint preserves only target-blocking dominated claims in an exact retained stash',
    result.status === 'committed' && stash && /^[0-9a-f]{40}$/.test(stash.oid)
    && JSON.stringify(stash.paths) === JSON.stringify([ignoredPath, newerPath, terminalPath].sort())
    && !stash.paths.includes(unrelatedPath) && stash.evidence.length === 3
    && stash.evidence.some((item) => item.path === terminalPath && item.local_status === 'claimed' && item.target_status === 'tested')
    && stash.evidence.some((item) => item.path === newerPath && item.target_timestamp > item.local_timestamp)
    && stash.evidence.some((item) => item.path === ignoredPath && item.target_status === 'tested'));
  ok('feature graph advances to canonical terminal/newer claims while unrelated untracked data remains',
    JSON.parse(fs.readFileSync(path.join(fixture.featureGraph, terminalPath), 'utf8')).status === 'tested'
    && JSON.parse(fs.readFileSync(path.join(fixture.featureGraph, newerPath), 'utf8')).claimed_at === '2026-08-30T20:03:00.000Z'
    && JSON.parse(fs.readFileSync(path.join(fixture.featureGraph, ignoredPath), 'utf8')).status === 'tested'
    && fs.readFileSync(path.join(fixture.featureGraph, unrelatedPath), 'utf8') === 'preserve me\n'
    && fs.readFileSync(path.join(fixture.featureGraph, unrelatedIgnoredPath), 'utf8') === 'preserve ignored me\n');
  ok('retained stash contains byte-recoverable originals for every and only preserved path',
    git(fixture.featureGraph, ['show', `${stash.oid}^3:${terminalPath}`]) === localTerminal.trim()
    && git(fixture.featureGraph, ['show', `${stash.oid}^3:${newerPath}`]) === localNewer.trim()
    && git(fixture.featureGraph, ['show', `${stash.oid}^3:${ignoredPath}`]) === localIgnored.trim()
    && !git(fixture.featureGraph, ['stash', 'show', '--include-untracked', '--name-only', '--format=', stash.oid]).split('\n').includes(unrelatedPath)
    && !git(fixture.featureGraph, ['stash', 'show', '--include-untracked', '--name-only', '--format=', stash.oid]).split('\n').includes(unrelatedIgnoredPath)
    && git(fixture.featureGraph, ['stash', 'list', '--format=%H']).split('\n').includes(stash.oid));
}

async function testFeatureCheckpointRefusesUnsafeBlockersWithoutMutation() {
  const fixture = await featureCheckpointFixture();
  const blockers = {
    'blocking.txt': 'unrecognized local evidence\n',
    'claims/local-malformed.json': '{not json\n',
    'claims/target-malformed.json': claim('task/target-malformed', 'claimed', '2026-08-30T20:00:00.000Z'),
    'claims/not-dominated.json': claim('task/not-dominated', 'tested', '2026-08-30T20:04:00.000Z', 'completed_at'),
  };
  for (const [file, value] of Object.entries(blockers)) write(path.join(fixture.featureGraph, file), value);
  write(path.join(fixture.graphDir, 'blocking.txt'), 'canonical value\n');
  write(path.join(fixture.graphDir, 'claims/local-malformed.json'), claim('task/local-malformed', 'tested', '2026-08-30T20:05:00.000Z', 'completed_at'));
  write(path.join(fixture.graphDir, 'claims/target-malformed.json'), '{not json either\n');
  write(path.join(fixture.graphDir, 'claims/not-dominated.json'), claim('task/not-dominated', 'claimed', '2026-08-30T20:03:00.000Z'));
  const beforeHead = git(fixture.featureGraph, ['rev-parse', 'HEAD']);
  const beforeStatus = git(fixture.featureGraph, ['status', '--porcelain=v1', '--untracked-files=all']);
  const beforeStashes = git(fixture.featureGraph, ['stash', 'list', '--format=%H']);
  let error = null;
  try { await lifecycle.checkpointFeature(fixture.repo, fixture.feature); } catch (caught) { error = caught; }

  ok('feature checkpoint refuses malformed, non-claim, and non-dominating target blockers together',
    error && Object.keys(blockers).every((file) => error.message.includes(file)), error && error.message);
  ok('unsafe blocker refusal leaves feature graph index, worktree, and stash list unchanged',
    git(fixture.featureGraph, ['rev-parse', 'HEAD']) === beforeHead
    && git(fixture.featureGraph, ['status', '--porcelain=v1', '--untracked-files=all']) === beforeStatus
    && git(fixture.featureGraph, ['stash', 'list', '--format=%H']) === beforeStashes
    && Object.entries(blockers).every(([file, value]) => fs.readFileSync(path.join(fixture.featureGraph, file), 'utf8') === value));
}

async function main() {
  try {
    // testDerive is pure string work; every other case drives lifecycle.init(), which shells out to
    // `git filter-repo` to extract .graph history into the submodule. filter-repo is a SEPARATE
    // install (a git extension, not part of git), so its absence is a property of the machine, not
    // of the code under test — skip those cases with a visible marker instead of failing the suite.
    await testDerive();
    if (!hasGitFilterRepo()) {
      console.log('SKIP  graph extraction/rollback/checkpoint cases (git filter-repo is not installed)');
    } else {
      await testDryRunAndExtraction();
      await testRollback();
      await testDirtyRefusal();
      await testReviewFixes();
      await testSyncFlushCheckpointStatus();
      await testFeatureCheckpoint();
      await testFeatureCheckpointPreservesDominatedClaims();
      await testFeatureCheckpointRefusesUnsafeBlockersWithoutMutation();
    }
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
