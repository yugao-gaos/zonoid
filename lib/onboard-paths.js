'use strict';

const fs = require('fs');
const path = require('path');
const { RUNTIME_DIRNAME } = require('./runtime-paths');

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
 * existing projects and also works for linked worktrees where `.git` is a pointer file.
 */
function ensureOnboardRuntimeIgnored(workspaceRootArg) {
  const root = workspaceRoot(workspaceRootArg);
  const marker = path.join(root, '.git');
  let gitDir = null;
  try {
    if (fs.statSync(marker).isDirectory()) {
      gitDir = marker;
    } else {
      const match = fs.readFileSync(marker, 'utf8').match(/^gitdir:\s*(.+?)\s*$/im);
      if (match) gitDir = path.resolve(root, match[1]);
    }
  } catch { return false; }
  if (!gitDir) return false;

  // Linked worktrees keep info/exclude in the common Git directory, while submodules and normal
  // repositories use their own gitdir. Resolve `commondir` exactly as Git does without spawning a
  // process on the latency-sensitive enqueue route.
  let commonDir = gitDir;
  try {
    const reported = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim();
    if (reported) commonDir = path.resolve(gitDir, reported);
  } catch { /* normal repositories have no commondir file */ }
  const excludeFile = path.join(commonDir, 'info', 'exclude');
  const rule = `${RUNTIME_DIRNAME}/`;
  let existing = '';
  try { existing = fs.readFileSync(excludeFile, 'utf8'); } catch (err) {
    if (!err || err.code !== 'ENOENT') throw err;
  }
  if (existing.split(/\r?\n/).some((line) => line.trim() === rule)) return true;

  fs.mkdirSync(path.dirname(excludeFile), { recursive: true });
  const prefix = existing && !existing.endsWith('\n') ? '\n' : '';
  fs.appendFileSync(excludeFile, `${prefix}${rule}\n`);
  return true;
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
  ensureOnboardRuntimeIgnored,
};
