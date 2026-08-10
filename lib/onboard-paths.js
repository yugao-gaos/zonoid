'use strict';

const fs = require('fs');
const path = require('path');
const { RUNTIME_DIRNAME } = require('./runtime-paths');

const GIT_PATH_MAX_BYTES = 4096;
const GIT_EXCLUDE_MAX_BYTES = 1024 * 1024;

function unsafeRead(reason) {
  return { ok: false, unsafe: true, reason };
}

function statIdentity(stat) {
  const value = (name) => stat && stat[name] !== undefined ? String(stat[name]) : null;
  return {
    dev: value('dev'),
    ino: value('ino'),
    mode: value('mode'),
    nlink: value('nlink'),
    uid: value('uid'),
    gid: value('gid'),
    rdev: value('rdev'),
    size: value('size'),
    mtimeNs: value('mtimeNs'),
    ctimeNs: value('ctimeNs'),
  };
}

function sameStat(left, right) {
  const a = statIdentity(left);
  const b = statIdentity(right);
  return Object.keys(a).every((key) => a[key] === b[key]);
}

function sameObject(left, right) {
  return !!left && !!right
    && String(left.dev) === String(right.dev)
    && String(left.ino) === String(right.ino)
    && String(left.mode) === String(right.mode);
}

// Read only one stable, bounded regular-file image. O_NONBLOCK keeps a path-swap to a FIFO from
// hanging between lstat and open; O_NOFOLLOW plus the descriptor/path identity checks reject a
// symlink or replacement even on platforms where one of those flags is unavailable.
function readStableRegularFile(file, maxBytes) {
  let before;
  try { before = fs.lstatSync(file, { bigint: true }); } catch (err) {
    if (err && err.code === 'ENOENT') return { ok: false, absent: true, reason: 'absent' };
    throw err;
  }
  if (!before.isFile()) return unsafeRead('not_regular');
  if (before.nlink !== 1n) return unsafeRead('linked_file');
  if (before.size < 0n || before.size > BigInt(maxBytes)) return unsafeRead('oversize');

  let fd;
  try {
    const flags = fs.constants.O_RDONLY
      | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_NONBLOCK || 0);
    fd = fs.openSync(file, flags);
  } catch (err) {
    if (err && ['ENOENT', 'ELOOP', 'ENXIO', 'ENODEV'].includes(err.code)) {
      return unsafeRead('replaced_before_open');
    }
    throw err;
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    if (!opened.isFile() || opened.nlink !== 1n || !sameObject(before, opened)) {
      return unsafeRead('replaced_before_open');
    }
    if (opened.size < 0n || opened.size > BigInt(maxBytes)) return unsafeRead('oversize');
    const length = Number(opened.size);
    const bytes = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const count = fs.readSync(fd, bytes, offset, length - offset, offset);
      if (count === 0) break;
      offset += count;
    }
    const after = fs.fstatSync(fd, { bigint: true });
    let pathAfter;
    try { pathAfter = fs.lstatSync(file, { bigint: true }); } catch {
      return unsafeRead('replaced_during_read');
    }
    if (offset !== length || !sameStat(opened, after) || !sameObject(after, pathAfter)) {
      return unsafeRead('replaced_during_read');
    }
    return { ok: true, bytes, stat: after };
  } finally {
    fs.closeSync(fd);
  }
}

function workspaceName(workspaceRoot) {
  const clean = String(workspaceRoot || '').replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || 'workspace';
}

function workspaceRoot(workspaceRootArg) {
  return path.resolve(workspaceRootArg || process.cwd());
}

function onboardRuntimeRoot(workspaceRootArg) {
  return path.join(workspaceRoot(workspaceRootArg), RUNTIME_DIRNAME, 'onboard');
}

function defaultOnboardOutDir(workspaceRootArg) {
  const root = workspaceRoot(workspaceRootArg);
  return path.join(root, RUNTIME_DIRNAME, 'onboard', workspaceName(root));
}

function legacyGraphOnboardOutDir(workspaceRootArg) {
  return path.join(workspaceRoot(workspaceRootArg), '.graph', 'onboard');
}

function legacyBenchOnboardRoot(workspaceRootArg) {
  return path.join(workspaceRoot(workspaceRootArg), 'bench', 'onboard');
}

function legacyBenchOnboardOutDir(workspaceRootArg) {
  const root = workspaceRoot(workspaceRootArg);
  return path.join(root, 'bench', 'onboard', workspaceName(root));
}

function supportedOnboardOutDirs(workspaceRootArg) {
  const root = workspaceRoot(workspaceRootArg);
  return [
    { kind: 'default', outDir: defaultOnboardOutDir(root) },
    { kind: 'legacy_graph', outDir: legacyGraphOnboardOutDir(root) },
    { kind: 'legacy_bench', outDir: legacyBenchOnboardOutDir(root) },
  ];
}

class OnboardPathError extends Error {
  constructor(message, statusCode = 400) {
    super(message);
    this.name = 'OnboardPathError';
    this.statusCode = statusCode;
  }
}

function realpathExistingDirectory(dir, label) {
  let stat;
  try { stat = fs.statSync(dir); } catch {
    throw new OnboardPathError(`${label} must be an existing directory`);
  }
  if (!stat.isDirectory()) throw new OnboardPathError(`${label} must be an existing directory`);
  try { return fs.realpathSync(dir); } catch {
    throw new OnboardPathError(`${label} could not be resolved`);
  }
}

function isWithin(parent, child) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith(`..${path.sep}`) && rel !== '..' && !path.isAbsolute(rel));
}

function registeredRepoList(registeredWorkspaces) {
  const value = typeof registeredWorkspaces === 'function'
    ? registeredWorkspaces()
    : registeredWorkspaces;
  if (value instanceof Set) return Array.from(value);
  return Array.isArray(value) ? value : [];
}

function projectedRealpath(target) {
  const missing = [];
  let cursor = target;
  while (true) {
    try {
      return path.join(fs.realpathSync(cursor), ...missing.reverse());
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    const parent = path.dirname(cursor);
    if (parent === cursor) throw new OnboardPathError('onboarding output path could not be resolved');
    missing.push(path.basename(cursor));
    cursor = parent;
  }
}

function assertNoSymlinkBelowRepo(repoPath, outDir) {
  const rel = path.relative(repoPath, outDir);
  let cursor = repoPath;
  for (const part of rel.split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    try {
      if (fs.lstatSync(cursor).isSymbolicLink()) {
        throw new OnboardPathError('onboarding output path must not contain symlinks');
      }
    } catch (err) {
      if (err instanceof OnboardPathError) throw err;
      if (err && err.code === 'ENOENT') break;
      throw new OnboardPathError('onboarding output path could not be inspected');
    }
  }
}

/**
 * Resolve the one project and output directory an onboarding request may touch.
 *
 * Only an existing registered project is accepted, and its output must be exactly one of the
 * current default or two documented legacy roots. The function is deliberately read-only: callers
 * can validate an uncreated default path without allowing a rejected path to be created first.
 */
function resolveOnboardPaths({ repo, outDir, registeredWorkspaces } = {}) {
  if (typeof repo !== 'string' || !repo.trim()) throw new OnboardPathError('repo required');
  const requestedRepo = path.resolve(repo);
  const requestedReal = realpathExistingDirectory(requestedRepo, 'repo');
  const registered = registeredRepoList(registeredWorkspaces);
  let registeredRepo = null;
  for (const candidate of registered) {
    if (typeof candidate !== 'string' || !candidate) continue;
    const abs = path.resolve(candidate);
    let real;
    try { real = realpathExistingDirectory(abs, 'registered repo'); } catch { continue; }
    if (real === requestedReal) {
      registeredRepo = abs;
      break;
    }
  }
  if (!registeredRepo) throw new OnboardPathError('repo is not a registered project', 403);

  const supported = supportedOnboardOutDirs(registeredRepo);
  let chosen = supported[0];
  if (outDir !== undefined && outDir !== null && outDir !== '') {
    if (typeof outDir !== 'string' || !path.isAbsolute(outDir)) {
      throw new OnboardPathError('outDir must be an absolute supported onboarding root');
    }
    if (outDir.split(/[\\/]+/).includes('..')) {
      throw new OnboardPathError('outDir traversal is not allowed');
    }
    const requestedOut = path.resolve(outDir);
    chosen = supported.find((entry) => path.resolve(entry.outDir) === requestedOut);
    if (!chosen) throw new OnboardPathError('outDir must equal a supported onboarding root for repo');
  }

  const resolvedOutDir = path.resolve(chosen.outDir);
  if (!isWithin(registeredRepo, resolvedOutDir)) {
    throw new OnboardPathError('onboarding output path must remain inside repo');
  }
  assertNoSymlinkBelowRepo(registeredRepo, resolvedOutDir);
  let projected;
  try { projected = projectedRealpath(resolvedOutDir); } catch (err) {
    if (err instanceof OnboardPathError) throw err;
    throw new OnboardPathError('onboarding output path could not be resolved');
  }
  if (!isWithin(requestedReal, projected)) {
    throw new OnboardPathError('onboarding output path escapes repo through a symlink');
  }
  return { repo: registeredRepo, repoRealpath: requestedReal, outDir: resolvedOutDir, kind: chosen.kind };
}

/**
 * Keep workspace-local onboarding state out of `git status` without editing a project's
 * committed .gitignore. Git's per-repository exclude file is local metadata, so this is safe for
 * existing projects. Linked worktrees are expected to be canonicalized to their primary checkout;
 * an unresolved pointer outside that canonical root is an advisory skip.
 */
function existingContainedDirectory(root, candidate) {
  const resolved = path.resolve(candidate);
  if (!isWithin(root, resolved)) return null;
  let cursor = root;
  for (const part of path.relative(root, resolved).split(path.sep).filter(Boolean)) {
    cursor = path.join(cursor, part);
    let stat;
    try { stat = fs.lstatSync(cursor, { bigint: true }); } catch { return null; }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return null;
  }
  try {
    return fs.realpathSync(resolved) === resolved ? resolved : null;
  } catch { return null; }
}

function singlePathLine(bytes, prefix) {
  if (!Buffer.isBuffer(bytes) || bytes.includes(0)) return null;
  const raw = bytes.toString('utf8');
  const pattern = prefix
    ? new RegExp(`^${prefix}:\\s*([^\\r\\n]+?)\\s*(?:\\r?\\n)?$`, 'i')
    : /^\s*([^\r\n]+?)\s*(?:\r?\n)?$/;
  const match = raw.match(pattern);
  return match && match[1] ? match[1] : null;
}

function appendToStableRegularFile(file, snapshot, text) {
  let fd;
  try {
    const flags = fs.constants.O_WRONLY | fs.constants.O_APPEND
      | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_NONBLOCK || 0);
    fd = fs.openSync(file, flags);
  } catch (err) {
    if (err && ['ENOENT', 'ELOOP', 'ENXIO', 'ENODEV'].includes(err.code)) return false;
    throw err;
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    let pathStat;
    try { pathStat = fs.lstatSync(file, { bigint: true }); } catch { return false; }
    if (!opened.isFile() || !sameStat(snapshot, opened) || !sameObject(opened, pathStat)) return false;
    fs.writeSync(fd, text, null, 'utf8');
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

function createRegularFileNoFollow(file, text) {
  let fd;
  try {
    const flags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL
      | (fs.constants.O_NOFOLLOW || 0)
      | (fs.constants.O_NONBLOCK || 0);
    fd = fs.openSync(file, flags, 0o666);
  } catch (err) {
    if (err && ['EEXIST', 'ELOOP', 'ENXIO', 'ENODEV'].includes(err.code)) return false;
    throw err;
  }
  try {
    const opened = fs.fstatSync(fd, { bigint: true });
    let pathStat;
    try { pathStat = fs.lstatSync(file, { bigint: true }); } catch { return false; }
    if (!opened.isFile() || !sameObject(opened, pathStat)) return false;
    fs.writeSync(fd, text, null, 'utf8');
    return true;
  } finally {
    fs.closeSync(fd);
  }
}

function ensureOnboardRuntimeIgnored(workspaceRootArg) {
  const requestedRoot = workspaceRoot(workspaceRootArg);
  let root;
  try {
    const rootStat = fs.lstatSync(requestedRoot);
    if (!rootStat.isDirectory() && !rootStat.isSymbolicLink()) return false;
    root = fs.realpathSync(requestedRoot);
  } catch { return false; }
  const marker = path.join(root, '.git');
  let gitDir = null;
  try {
    const markerStat = fs.lstatSync(marker);
    if (markerStat.isDirectory() && !markerStat.isSymbolicLink()) {
      gitDir = marker;
    } else if (markerStat.isFile()) {
      const markerRead = readStableRegularFile(marker, GIT_PATH_MAX_BYTES);
      if (!markerRead.ok) return false;
      const reported = singlePathLine(markerRead.bytes, 'gitdir');
      if (!reported) return false;
      const candidate = path.resolve(root, reported);
      gitDir = existingContainedDirectory(root, candidate);
    }
  } catch { return false; }
  if (!gitDir) return false;
  gitDir = existingContainedDirectory(root, gitDir);
  if (!gitDir) return false;

  // Linked worktrees keep info/exclude in the common Git directory, while submodules and normal
  // repositories use their own gitdir. Resolve `commondir` exactly as Git does without spawning a
  // process on the latency-sensitive enqueue route.
  let commonDir = gitDir;
  try {
    const commonRead = readStableRegularFile(path.join(gitDir, 'commondir'), GIT_PATH_MAX_BYTES);
    if (!commonRead.absent) {
      if (!commonRead.ok) return false;
      const reported = singlePathLine(commonRead.bytes, null);
      if (!reported) return false;
      const candidate = path.resolve(gitDir, reported);
      // A canonical primary checkout has no commondir. If one is present, keep it inside the
      // already-contained gitdir; arbitrary linked-worktree/common-dir pointers are advisory skips.
      if (!isWithin(gitDir, candidate)) return false;
      commonDir = existingContainedDirectory(root, candidate);
      if (!commonDir) return false;
    }
  } catch { return false; }
  const infoDir = path.join(commonDir, 'info');
  if (!existingContainedDirectory(root, infoDir)) {
    try { fs.mkdirSync(infoDir); } catch (err) {
      if (!err || err.code !== 'EEXIST') return false;
    }
    if (!existingContainedDirectory(root, infoDir)) return false;
  }
  const excludeFile = path.join(commonDir, 'info', 'exclude');
  const rule = `${RUNTIME_DIRNAME}/`;
  const excludeRead = readStableRegularFile(excludeFile, GIT_EXCLUDE_MAX_BYTES);
  if (!excludeRead.ok && !excludeRead.absent) return false;
  const existing = excludeRead.ok ? excludeRead.bytes.toString('utf8') : '';
  if (existing.split(/\r?\n/).some((line) => line.trim() === rule)) return true;

  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  const addition = `${prefix}${rule}\n`;
  return excludeRead.ok
    ? appendToStableRegularFile(excludeFile, excludeRead.stat, addition)
    : createRegularFileNoFollow(excludeFile, addition);
}

module.exports = {
  workspaceName,
  workspaceRoot,
  onboardRuntimeRoot,
  defaultOnboardOutDir,
  legacyGraphOnboardOutDir,
  legacyBenchOnboardRoot,
  legacyBenchOnboardOutDir,
  supportedOnboardOutDirs,
  resolveOnboardPaths,
  OnboardPathError,
  readStableRegularFile,
  ensureOnboardRuntimeIgnored,
};
