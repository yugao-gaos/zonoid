'use strict';

const fs = require('fs');
const path = require('path');
const { execFile } = require('child_process');

const queues = new Map();

function repoKey(repoRoot) {
  const absolute = path.resolve(repoRoot);
  try {
    return fs.realpathSync(absolute);
  } catch {
    return absolute;
  }
}

function serialize(repoRoot, fn) {
  const key = repoKey(repoRoot);
  const previous = queues.get(key) || Promise.resolve();
  const result = previous.catch(() => {}).then(fn);
  const tail = result.catch(() => {});
  queues.set(key, tail);
  return result.finally(() => {
    if (queues.get(key) === tail) queues.delete(key);
  });
}

function inspect(repoRoot) {
  const graphDir = path.join(path.resolve(repoRoot), '.graph');
  let stat;
  try {
    stat = fs.statSync(graphDir);
  } catch {
    return { kind: 'missing', graphDir };
  }
  if (!stat.isDirectory()) return { kind: 'missing', graphDir };
  try {
    const gitMarker = fs.statSync(path.join(graphDir, '.git'));
    if (gitMarker.isDirectory() || gitMarker.isFile()) return { kind: 'submodule', graphDir };
  } catch {}
  return { kind: 'ordinary', graphDir };
}

function detect(repoRoot) {
  return inspect(repoRoot).kind;
}

function runGit(cwd, args, options = {}) {
  return new Promise((resolve, reject) => {
    execFile('git', ['-C', cwd, ...args], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 10 * 1024 * 1024,
      ...options,
    }, (error, stdout, stderr) => {
      if (!error) return resolve(String(stdout || '').trim());
      error.stdout = String(stdout || '').trim();
      error.stderr = String(stderr || '').trim();
      reject(error);
    });
  });
}

async function gitResult(cwd, args) {
  try {
    return { ok: true, stdout: await runGit(cwd, args) };
  } catch (error) {
    return { ok: false, error };
  }
}

function errorText(error) {
  return String((error && (error.stderr || error.message)) || error || 'git failed').trim();
}

async function currentCommit(graphDir) {
  const result = await gitResult(graphDir, ['rev-parse', 'HEAD']);
  return result.ok ? result.stdout : null;
}

async function remoteDefaultBranch(graphDir) {
  const local = await gitResult(graphDir, ['symbolic-ref', '--quiet', '--short', 'refs/remotes/origin/HEAD']);
  if (local.ok && local.stdout.startsWith('origin/')) return local.stdout.slice('origin/'.length);

  const remote = await gitResult(graphDir, ['ls-remote', '--symref', 'origin', 'HEAD']);
  if (remote.ok) {
    const match = remote.stdout.match(/^ref:\s+refs\/heads\/([^\s]+)\s+HEAD$/m);
    if (match) return match[1];
  }
  return 'main';
}

async function attachDetachedHead(graphDir) {
  const head = await gitResult(graphDir, ['symbolic-ref', '--quiet', '--short', 'HEAD']);
  if (head.ok && head.stdout) return head.stdout;
  const branch = await remoteDefaultBranch(graphDir);
  await runGit(graphDir, ['checkout', '-B', branch, 'HEAD']);
  return branch;
}

async function trackingRefExists(graphDir, branch) {
  return (await gitResult(graphDir, ['show-ref', '--verify', '--quiet', `refs/remotes/origin/${branch}`])).ok;
}

async function fetchAndRebase(graphDir, branch) {
  await runGit(graphDir, ['fetch', '--prune', 'origin']);
  if (!(await trackingRefExists(graphDir, branch))) return;
  try {
    await runGit(graphDir, ['rebase', `refs/remotes/origin/${branch}`]);
  } catch (error) {
    await gitResult(graphDir, ['rebase', '--abort']);
    throw error;
  }
}

function skipped(kind) {
  return { status: 'skipped', kind, commit: null };
}

async function flushSubmodule(info, options) {
  const graphDir = info.graphDir;
  const message = options.message || 'zonoid: persist graph state';
  const shouldPush = options.push !== false;
  const retries = Number.isInteger(options.retries) && options.retries >= 0 ? options.retries : 2;
  let branch = null;

  try {
    branch = await attachDetachedHead(graphDir);
    // daemon.port is written into the mounted graph directory for discovery but is machine-local
    // runtime state, never durable graph history.
    await runGit(graphDir, ['add', '-A', '--', '.', ':(exclude)daemon.port']);
    const staged = await gitResult(graphDir, ['diff', '--cached', '--quiet', '--exit-code']);
    if (!staged.ok) await runGit(graphDir, ['commit', '-m', message]);
  } catch (error) {
    return { status: 'error', kind: info.kind, branch, commit: await currentCommit(graphDir), error: errorText(error) };
  }

  let commit = await currentCommit(graphDir);
  if (!shouldPush) return { status: 'pending', kind: info.kind, branch, commit, error: null };

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      await fetchAndRebase(graphDir, branch);
      commit = await currentCommit(graphDir);
      await runGit(graphDir, ['push', 'origin', `HEAD:refs/heads/${branch}`]);
      return { status: 'pushed', kind: info.kind, branch, commit, attempts: attempt + 1, error: null };
    } catch (error) {
      commit = await currentCommit(graphDir);
      if (attempt === retries) {
        return { status: 'pending', kind: info.kind, branch, commit, attempts: attempt + 1, error: errorText(error) };
      }
    }
  }

  return { status: 'pending', kind: info.kind, branch, commit, attempts: retries + 1, error: 'push retries exhausted' };
}

function flush(repoRoot, options = {}) {
  return serialize(repoRoot, async () => {
    const info = inspect(repoRoot);
    if (info.kind !== 'submodule') return skipped(info.kind);
    return flushSubmodule(info, options);
  });
}

function sync(repoRoot, options = {}) {
  return serialize(repoRoot, async () => {
    const info = inspect(repoRoot);
    if (info.kind !== 'submodule') return skipped(info.kind);
    const graphDir = info.graphDir;
    let branch = null;
    try {
      branch = await attachDetachedHead(graphDir);
      if (options.latest !== false) await fetchAndRebase(graphDir, branch);
      return { status: 'synced', kind: info.kind, branch, commit: await currentCommit(graphDir), error: null };
    } catch (error) {
      return { status: 'pending', kind: info.kind, branch, commit: await currentCommit(graphDir), error: errorText(error) };
    }
  });
}

function ensureRemoteCommit(repoRoot, commit) {
  return serialize(repoRoot, async () => {
    const info = inspect(repoRoot);
    if (info.kind !== 'submodule' || !commit) return false;
    try {
      const graphDir = info.graphDir;
      await runGit(graphDir, ['fetch', '--prune', 'origin']);
      const heads = await runGit(graphDir, ['ls-remote', '--heads', 'origin']);
      const commits = heads
        .split('\n')
        .map((line) => line.trim().split(/\s+/)[0])
        .filter(Boolean);
      for (const head of commits) {
        if ((await gitResult(graphDir, ['merge-base', '--is-ancestor', commit, head])).ok) return true;
      }
    } catch {}
    return false;
  });
}

module.exports = { detect, flush, sync, ensureRemoteCommit, serialize };
