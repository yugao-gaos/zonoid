'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile } = require('child_process');

const graphRepo = require('./graph-repo');

function execGit(cwd, args) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
    }, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout || '').trim());
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
  const configured = options.remote || await originRemote(repoRoot, options);
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

async function rollback(repoRoot, snapshot, options = {}) {
  const graphModules = path.join(repoRoot, '.git', 'modules', '.graph');
  fs.rmSync(path.join(repoRoot, '.graph'), { recursive: true, force: true });
  fs.rmSync(graphModules, { recursive: true, force: true });
  restoreFile(path.join(repoRoot, '.graph'), snapshot.graph);
  restoreFile(path.join(repoRoot, '.gitmodules'), snapshot.gitmodules);
  if (snapshot.index.exists) {
    fs.mkdirSync(path.dirname(path.join(repoRoot, '.git', 'index')), { recursive: true });
    fs.copyFileSync(snapshot.index.target, path.join(repoRoot, '.git', 'index'));
  }
  await callHook(options, 'rollback', { repoRoot });
}

async function currentHead(repoRoot, options = {}) {
  const result = await gitResult(repoRoot, ['rev-parse', 'HEAD'], options);
  return result.ok ? result.stdout : null;
}

function dirtyEntries(status) {
  return String(status || '').split('\n').map((line) => line.slice(3)).filter(Boolean);
}

function isGraphPath(file) {
  return file === '.graph' || file.startsWith('.graph/');
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
  const snapshot = {
    graph: snapshotFile(path.join(repoRoot, '.graph'), snapshotRoot, 'graph'),
    gitmodules: snapshotFile(path.join(repoRoot, '.gitmodules'), snapshotRoot, 'gitmodules'),
    index: snapshotFile(path.join(repoRoot, '.git', 'index'), snapshotRoot, 'index'),
  };

  try {
    await callHook(options, 'before-extract', { repoRoot, remote, branch });
    await git(tempRoot, ['clone', repoRoot, cloneRoot], options);
    await git(cloneRoot, ['filter-repo', '--path', '.graph', '--path-rename', '.graph/:', '--force'], options);
    await callHook(options, 'after-extract', { cloneRoot });

    copyTree(path.join(repoRoot, '.graph'), cloneRoot, true);
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

async function gitlinkStatus(repoRoot, options = {}) {
  const output = await git(repoRoot, ['status', '--porcelain=v1', '--', '.gitmodules', '.graph'], options);
  let staged = false;
  let dirty = false;
  for (const line of String(output || '').split('\n').filter(Boolean)) {
    const xy = line.slice(0, 2);
    const file = line.slice(3);
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

module.exports = {
  deriveRemote,
  init,
  sync,
  flush,
  checkpoint,
  status,
};
