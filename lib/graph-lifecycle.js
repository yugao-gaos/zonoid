'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const graphRepo = require('./graph-repo');

const TERMINAL_CLAIM_STATUSES = new Set(['done', 'tested', 'failed', 'canceled', 'released']);
const KNOWN_CLAIM_STATUSES = new Set(['claimed', ...TERMINAL_CLAIM_STATUSES]);
const FEATURE_CHECKPOINT_STASH_PREFIX = 'zonoid feature graph checkpoint blockers';

function execGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout || ''));
      error.stdout = String(stdout || '').trim();
      error.stderr = String(stderr || '').trim();
      reject(error);
    });
  });
}

function errorText(error) {
  return String((error && (error.stderr || error.message)) || error || 'git failed').trim();
}

function runner(options = {}) {
  return typeof options.run === 'function'
    ? (cwd, args) => Promise.resolve(options.run(cwd, args))
    : execGit;
}

async function git(cwd, args, options = {}) {
  const result = await runner(options)(cwd, args);
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'stdout')) {
    return String(result.stdout || '').trim();
  }
  return String(result || '').trim();
}

async function gitRaw(cwd, args, options = {}) {
  const result = await runner(options)(cwd, args);
  if (result && typeof result === 'object' && Object.prototype.hasOwnProperty.call(result, 'stdout')) {
    return String(result.stdout || '');
  }
  return String(result || '');
}

async function gitResult(cwd, args, options = {}) {
  try {
    return { ok: true, stdout: await git(cwd, args, options) };
  } catch (error) {
    return { ok: false, error };
  }
}

function remotePath(remote) {
  const value = String(remote || '').trim().replace(/\/+$/, '');
  const ssh = value.match(/^git@github\.com:([^/]+)\/([^/]+?)(?:\.git)?$/i);
  const https = value.match(/^https?:\/\/github\.com\/([^/]+)\/([^/]+?)(?:\.git)?$/i);
  const match = ssh || https;
  if (!match) return null;
  return `https://github.com/${match[1]}/${match[2]}-graph.git`;
}

async function originRemote(repoRoot, options = {}) {
  const result = await gitResult(repoRoot, ['config', '--get', 'remote.origin.url'], options);
  return result.ok ? result.stdout : null;
}

function deriveRemote(repoRootOrRemote) {
  const direct = remotePath(repoRootOrRemote);
  if (direct) return direct;
  if (typeof repoRootOrRemote === 'string' && /^(?:https?|git@)/i.test(repoRootOrRemote)) {
    return repoRootOrRemote;
  }
  throw new Error('deriveRemote requires a GitHub HTTPS or SSH remote URL');
}

async function deriveForRepo(repoRoot, options = {}) {
  if (options.remote) return options.remote;
  const configured = await originRemote(repoRoot, options);
  if (!configured) throw new Error('superproject has no origin remote; pass options.remote');
  return remotePath(configured) || configured;
}

async function callHook(options, step, context) {
  const hook = options.failHook || options.fail || options.onStep;
  if (typeof hook === 'function') await hook(step, context);
}

function copyTree(source, target, excludeGit = false) {
  fs.mkdirSync(target, { recursive: true });
  for (const entry of fs.readdirSync(source, { withFileTypes: true })) {
    if (excludeGit && entry.name === '.git') continue;
    const from = path.join(source, entry.name);
    const to = path.join(target, entry.name);
    fs.cpSync(from, to, { recursive: true, force: true });
  }
}

function snapshotFile(file, dir, name) {
  const target = path.join(dir, name);
  if (!fs.existsSync(file)) return { exists: false, target };
  fs.cpSync(file, target, { recursive: true, force: true });
  return { exists: true, target };
}

function restoreFile(file, snapshot) {
  fs.rmSync(file, { recursive: true, force: true });
  if (snapshot.exists) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.cpSync(snapshot.target, file, { recursive: true, force: true });
  }
}

async function gitPath(repoRoot, name, options = {}) {
  const value = await git(repoRoot, ['rev-parse', '--git-path', name], options);
  return path.isAbsolute(value) ? value : path.resolve(repoRoot, value);
}

async function rollback(repoRoot, snapshot, options = {}) {
  const graphModules = snapshot.gitModulesPath || await gitPath(repoRoot, 'modules/.graph', options);
  fs.rmSync(path.join(repoRoot, '.graph'), { recursive: true, force: true });
  fs.rmSync(graphModules, { recursive: true, force: true });
  restoreFile(path.join(repoRoot, '.graph'), snapshot.graph);
  restoreFile(path.join(repoRoot, '.gitmodules'), snapshot.gitmodules);
  if (snapshot.index.exists) {
    fs.mkdirSync(path.dirname(snapshot.indexPath), { recursive: true });
    fs.copyFileSync(snapshot.index.target, snapshot.indexPath);
  }
  await callHook(options, 'rollback', { repoRoot });
}

async function currentHead(repoRoot, options = {}) {
  const result = await gitResult(repoRoot, ['rev-parse', 'HEAD'], options);
  return result.ok ? result.stdout : null;
}

function dirtyEntries(status) {
  return String(status || '').split('\n').map((line) => {
    if (/^[ MADRCU?!][ MADRCU?!] /.test(line)) return line.slice(3);
    return line.slice(2);
  }).filter(Boolean);
}

function isGraphPath(file) {
  return file === '.graph' || file.startsWith('.graph/');
}

function safeGraphPath(file) {
  const value = String(file || '');
  if (!value || path.posix.isAbsolute(value) || value.includes('\0') || value.includes('\r') || value.includes('\n')) return false;
  const parts = value.split('/');
  return parts.every((part) => part && part !== '.' && part !== '..');
}

function claimPath(file) {
  return safeGraphPath(file) && /^claims\/(?:[^/]+\/)*[^/]+\.json$/.test(file);
}

function parseClaim(value, source) {
  let claim;
  try { claim = JSON.parse(value); } catch { throw new Error(`${source} claim is malformed JSON`); }
  if (!claim || typeof claim !== 'object' || Array.isArray(claim)
      || typeof claim.task_key !== 'string' || !claim.task_key.trim()
      || typeof claim.status !== 'string' || !KNOWN_CLAIM_STATUSES.has(claim.status)) {
    throw new Error(`${source} claim has an invalid task_key or status`);
  }
  if (!Number.isFinite(claimTimestamp(claim))) throw new Error(`${source} claim has no valid lifecycle timestamp`);
  return claim;
}

function claimTimestamp(claim) {
  const values = ['completed_at', 'updated_at', 'claimed_at']
    .map((field) => Date.parse(claim && claim[field] || ''))
    .filter(Number.isFinite);
  return values.length ? Math.max(...values) : Number.NaN;
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function targetClaimDominates(local, target) {
  if (local.task_key !== target.task_key) return false;
  const localTerminal = TERMINAL_CLAIM_STATUSES.has(local.status);
  const targetTerminal = TERMINAL_CLAIM_STATUSES.has(target.status);
  if (localTerminal !== targetTerminal) return targetTerminal;
  const localTime = claimTimestamp(local);
  const targetTime = claimTimestamp(target);
  if (localTime !== targetTime) return targetTime > localTime;
  return canonicalJson(local) === canonicalJson(target);
}

async function preserveFeatureCheckpointBlockers(repoRoot, featureWorktree, targetCommit, options = {}) {
  const featureMode = graphRepo.detect(featureWorktree);
  if (featureMode === 'missing') return { status: 'not-needed', targetCommit, paths: [], stash: null, evidence: [] };
  if (featureMode !== 'submodule') {
    const graphDir = path.join(featureWorktree, '.graph');
    if (featureMode === 'ordinary' && fs.readdirSync(graphDir).length === 0) {
      return { status: 'not-needed', targetCommit, paths: [], stash: null, evidence: [] };
    }
    throw new Error('feature graph checkpoint requires an initialized .graph submodule before blocker preservation');
  }
  const targetGraph = path.join(repoRoot, '.graph');
  const featureGraph = path.join(featureWorktree, '.graph');
  const targetEntries = new Map();
  for (const row of (await git(targetGraph, ['ls-tree', '-r', '-z', targetCommit], options)).split('\0').filter(Boolean)) {
    const match = row.match(/^(\d+) ([^ ]+) ([0-9a-f]+)\t([\s\S]+)$/);
    if (!match) throw new Error('feature graph checkpoint could not parse the target graph tree');
    targetEntries.set(match[4], { mode: match[1], type: match[2], oid: match[3] });
  }
  const ordinaryUntracked = (await git(featureGraph, ['ls-files', '--others', '--exclude-standard', '-z'], options)).split('\0').filter(Boolean);
  const ignoredUntracked = (await git(featureGraph, ['ls-files', '--others', '--ignored', '--exclude-standard', '-z'], options)).split('\0').filter(Boolean);
  const untracked = Array.from(new Set([...ordinaryUntracked, ...ignoredUntracked]));
  const blocking = untracked.filter((file) => targetEntries.has(file)).sort();
  if (!blocking.length) return { status: 'not-needed', targetCommit, paths: [], stash: null, evidence: [] };

  const refused = [];
  const evidence = [];
  for (const file of blocking) {
    if (!claimPath(file)) {
      refused.push(`${file}: blocking path is not a recognized claim JSON file`);
      continue;
    }
    try {
      const localPath = path.join(featureGraph, file);
      const localStat = fs.lstatSync(localPath);
      const targetEntry = targetEntries.get(file);
      if (!localStat.isFile() || localStat.isSymbolicLink()) throw new Error('local claim is not a regular file');
      if (!targetEntry || targetEntry.type !== 'blob' || !/^100\d{3}$/.test(targetEntry.mode)) {
        throw new Error('target claim is not a regular file');
      }
      const local = parseClaim(fs.readFileSync(localPath, 'utf8'), 'local');
      const target = parseClaim(await git(targetGraph, ['show', `${targetCommit}:${file}`], options), 'target');
      if (!targetClaimDominates(local, target)) {
        refused.push(`${file}: target claim does not semantically dominate the local claim`);
        continue;
      }
      evidence.push({
        path: file,
        task_key: local.task_key,
        local_status: local.status,
        local_timestamp: new Date(claimTimestamp(local)).toISOString(),
        target_status: target.status,
        target_timestamp: new Date(claimTimestamp(target)).toISOString(),
      });
    } catch (error) {
      refused.push(`${file}: ${errorText(error)}`);
    }
  }
  if (refused.length) {
    throw new Error(`feature graph checkpoint refused blocking untracked paths: ${refused.join('; ')}`);
  }

  const before = await gitResult(featureGraph, ['rev-parse', '--verify', 'refs/stash'], options);
  const message = `${FEATURE_CHECKPOINT_STASH_PREFIX} ${targetCommit} ${new Date().toISOString()}`;
  await git(featureGraph, ['stash', 'push', '--all', '-m', message, '--', ...blocking], options);
  const after = await gitResult(featureGraph, ['rev-parse', '--verify', 'refs/stash'], options);
  if (!after.ok || (before.ok && before.stdout === after.stdout)) {
    throw new Error('feature graph checkpoint failed to retain blocking claims in a stash');
  }
  const stashedPaths = (await git(featureGraph, ['stash', 'show', '--include-untracked', '--name-only', '--format=', after.stdout], options))
    .split('\n').filter(Boolean).sort();
  if (JSON.stringify(stashedPaths) !== JSON.stringify(blocking)) {
    throw new Error(`feature graph checkpoint stash ${after.stdout} is not exact; retained for manual recovery`);
  }
  return {
    status: 'retained',
    targetCommit,
    paths: blocking,
    stash: { oid: after.stdout, ref: 'stash@{0}', message, paths: blocking, targetCommit, evidence },
    evidence,
  };
}

async function init(repoRoot, options = {}) {
  repoRoot = path.resolve(repoRoot);
  if (options.dryRun) {
    const mode = graphRepo.detect(repoRoot);
    const remote = await deriveForRepo(repoRoot, options);
    return { status: 'dry-run', dryRun: true, mode, remote, createRemote: options.createRemote === true };
  }
  if (options.yes !== true) throw new Error('init requires yes:true (or dryRun:true)');

  const mode = graphRepo.detect(repoRoot);
  if (mode === 'submodule') return { status: 'exists', mode };
  if (mode !== 'ordinary') throw new Error('init requires an ordinary .graph directory');

  const status = await git(repoRoot, ['status', '--porcelain=v1'], options);
  const unrelated = dirtyEntries(status).filter((file) => !isGraphPath(file));
  if (unrelated.length) throw new Error(`unrelated dirty files: ${unrelated.join(', ')}`);

  let remote = await deriveForRepo(repoRoot, options);
  const branchResult = await gitResult(repoRoot, ['symbolic-ref', '--quiet', '--short', 'HEAD'], options);
  const branch = branchResult.ok && branchResult.stdout ? branchResult.stdout : 'main';
  const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-graph-init-')));
  const cloneRoot = path.join(tempRoot, 'graph');
  const backupRoot = path.join(tempRoot, 'backup');
  const snapshotRoot = path.join(tempRoot, 'snapshot');
  fs.mkdirSync(snapshotRoot, { recursive: true });
  const indexPath = await gitPath(repoRoot, 'index', options);
  const gitModulesPath = await gitPath(repoRoot, 'modules/.graph', options);
  const snapshot = {
    graph: snapshotFile(path.join(repoRoot, '.graph'), snapshotRoot, 'graph'),
    gitmodules: snapshotFile(path.join(repoRoot, '.gitmodules'), snapshotRoot, 'gitmodules'),
    index: snapshotFile(indexPath, snapshotRoot, 'index'),
    indexPath,
    gitModulesPath,
  };

  try {
    await callHook(options, 'before-extract', { repoRoot, remote, branch });
    await git(tempRoot, ['clone', repoRoot, cloneRoot], options);
    await git(cloneRoot, ['filter-repo', '--path', '.graph', '--path-rename', '.graph/:', '--force'], options);
    await callHook(options, 'after-extract', { cloneRoot });

    for (const entry of fs.readdirSync(cloneRoot)) {
      if (entry !== '.git') fs.rmSync(path.join(cloneRoot, entry), { recursive: true, force: true });
    }
    copyTree(path.join(repoRoot, '.graph'), cloneRoot, true);
    await graphRepo.configureGraphRepo(cloneRoot);
    await git(cloneRoot, ['add', '-A', '--', '.'], options);
    const changed = await gitResult(cloneRoot, ['diff', '--cached', '--quiet', '--exit-code'], options);
    if (!changed.ok) await git(cloneRoot, ['commit', '-m', options.message || 'zonoid: extract graph history'], options);

    if (options.createRemote === true && typeof options.createRemoteCallback === 'function') {
      const created = await options.createRemoteCallback({ ownerRemote: remote, name: `${path.basename(repoRoot)}-graph`, private: options.private !== false });
      if (typeof created === 'string') remote = created;
      else if (created && (created.remote || created.clone_url || created.ssh_url || created.url)) {
        remote = created.remote || created.clone_url || created.ssh_url || created.url;
      }
      await callHook(options, 'after-create-remote', { remote });
    }

    const remoteResult = await gitResult(cloneRoot, ['remote', 'get-url', 'origin'], options);
    if (!remoteResult.ok) await git(cloneRoot, ['remote', 'add', 'origin', remote], options);
    else if (remoteResult.stdout !== remote) await git(cloneRoot, ['remote', 'set-url', 'origin', remote], options);
    await git(cloneRoot, ['push', '-u', 'origin', `HEAD:refs/heads/${branch}`], options);
    await callHook(options, 'after-push', { cloneRoot, remote, branch });

    fs.mkdirSync(backupRoot, { recursive: true });
    fs.cpSync(path.join(repoRoot, '.graph'), path.join(backupRoot, '.graph'), { recursive: true, force: true });
    fs.rmSync(path.join(repoRoot, '.graph'), { recursive: true, force: true });
    await git(repoRoot, ['rm', '-r', '--cached', '--ignore-unmatch', '--', '.graph'], options);
    await callHook(options, 'after-git-rm', { repoRoot });
    await git(repoRoot, ['-c', 'protocol.file.allow=always', 'submodule', 'add', '-b', branch, remote, '.graph'], options);
    await callHook(options, 'after-submodule-add', { repoRoot, remote, branch });
    await git(repoRoot, ['add', '--', '.gitmodules', '.graph'], options);
    return { status: 'initialized', mode: 'submodule', remote, branch, graphHead: await currentHead(path.join(repoRoot, '.graph'), options) };
  } catch (error) {
    try { await rollback(repoRoot, snapshot, options); } catch {}
    throw new Error(`graph init failed: ${errorText(error)}`);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }
}

async function sync(repoRoot, options = {}) {
  repoRoot = path.resolve(repoRoot);
  const mode = graphRepo.detect(repoRoot);
  if (mode === 'missing') {
    const gitlink = await gitResult(repoRoot, ['ls-files', '--stage', '--', '.graph'], options);
    if (gitlink.ok && gitlink.stdout) {
      await git(repoRoot, ['submodule', 'update', '--init', '--recursive', '--', '.graph'], options);
    }
  }
  return graphRepo.sync(repoRoot, options);
}

function flush(repoRoot, options = {}) {
  return graphRepo.flush(repoRoot, options);
}

function recoverRebase(repoRoot, options = {}) {
  return graphRepo.recoverInterruptedRebase(path.resolve(repoRoot), options);
}

async function gitlinkStatus(repoRoot, options = {}) {
  const output = await gitRaw(repoRoot, ['status', '--porcelain=v1', '--', '.gitmodules', '.graph'], options);
  let staged = false;
  let dirty = false;
  for (const line of String(output || '').split('\n').filter(Boolean)) {
    const xy = line.slice(0, 2);
    const file = /^[ MADRCU?!][ MADRCU?!] /.test(line) ? line.slice(3) : line.slice(2);
    if (!isGraphPath(file) && file !== '.gitmodules') continue;
    staged = staged || xy[0] !== ' ';
    dirty = dirty || xy[1] !== ' ';
  }
  return { staged, dirty };
}

async function status(repoRoot, options = {}) {
  repoRoot = path.resolve(repoRoot);
  const mode = graphRepo.detect(repoRoot);
  const graphHead = mode === 'missing' ? null : await currentHead(path.join(repoRoot, '.graph'), options);
  const remoteCommit = graphHead ? await graphRepo.ensureRemoteCommit(repoRoot, graphHead) : false;
  const gitlink = await gitlinkStatus(repoRoot, options);
  return {
    mode,
    graphHead,
    ensureRemoteCommit: remoteCommit,
    remoteCommit,
    gitlink,
    gitlinkStaged: gitlink.staged,
    gitlinkDirty: gitlink.dirty,
  };
}

async function checkpoint(repoRoot, options = {}) {
  const flushed = await flush(repoRoot, { ...options, push: true });
  if (flushed.status !== 'pushed' || !flushed.commit || !(await graphRepo.ensureRemoteCommit(repoRoot, flushed.commit))) {
    throw new Error(`graph checkpoint requires a pushed remote commit${flushed.error ? `: ${flushed.error}` : ''}`);
  }
  await git(repoRoot, ['add', '--', '.gitmodules', '.graph'], options);
  return { status: 'staged', commit: flushed.commit, flush: flushed };
}

async function checkpointFeature(repoRoot, featureWorktree, options = {}) {
  repoRoot = path.resolve(repoRoot);
  featureWorktree = path.resolve(featureWorktree);
  if (graphRepo.detect(repoRoot) !== 'submodule') {
    return { status: 'skipped', reason: 'ordinary_graph' };
  }

  const flushed = await graphRepo.flush(repoRoot, {
    ...options,
    push: true,
    message: options.message || 'zonoid: feature graph checkpoint',
  });
  if (flushed.status !== 'pushed' || !flushed.commit
      || !(await graphRepo.ensureRemoteCommit(repoRoot, flushed.commit))) {
    throw new Error(`feature graph checkpoint requires a pushed remote commit${flushed.error ? `: ${flushed.error}` : ''}`);
  }

  const preservation = await preserveFeatureCheckpointBlockers(repoRoot, featureWorktree, flushed.commit, options);
  await git(featureWorktree, ['-c', 'protocol.file.allow=always', 'submodule', 'update', '--init', '--recursive', '--', '.graph'], options);
  const synced = await graphRepo.sync(featureWorktree, { latest: true });
  if (synced.status !== 'synced') {
    throw new Error(`feature graph checkpoint sync failed${synced.error ? `: ${synced.error}` : ''}`);
  }
  if (!(await graphRepo.ensureRemoteCommit(featureWorktree, synced.commit))) {
    throw new Error('feature graph checkpoint commit is not available on the graph remote');
  }

  await git(featureWorktree, ['add', '--', '.graph'], options);
  const clean = await gitResult(featureWorktree, ['diff', '--cached', '--quiet', '--exit-code', '--', '.graph'], options);
  let pointerCommit = null;
  if (!clean.ok) {
    await git(featureWorktree, ['commit', '--no-verify', '-m', options.pointerMessage || 'chore: checkpoint graph state', '--', '.graph'], options);
    pointerCommit = await currentHead(featureWorktree, options);
  }
  return {
    status: pointerCommit ? 'committed' : 'unchanged',
    graphCommit: synced.commit,
    pointerCommit,
    flush: flushed,
    retainedStash: preservation.stash,
    preservation,
  };
}

module.exports = {
  deriveRemote,
  init,
  sync,
  flush,
  checkpoint,
  checkpointFeature,
  recoverRebase,
  status,
};
