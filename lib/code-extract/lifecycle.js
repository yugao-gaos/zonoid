'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const overlayStore = require('../overlay');
const workspaceRegistry = require('../workspace-registry');
const { supportedOnboardOutDirs } = require('../onboard-paths');
const {
  readOnboardQueue,
  readOnboardStatus,
  mutateOnboardStatus,
  validateOnboardQueue,
} = require('../onboard-state');

const DEFAULT_RETRY_BASE_MS = 5 * 1000;
const DEFAULT_RETRY_CAP_MS = 5 * 60 * 1000;
const DEFAULT_ONBOARD_GRACE_MS = 5 * 1000;

function count(value) {
  const n = Number(value);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

function pidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

function gitHead(repo) {
  try {
    return String(execFileSync('git', ['-C', repo, 'rev-parse', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })).trim() || null;
  } catch {
    return null;
  }
}

function registeredRepos(state) {
  const candidates = [];
  const seen = new Set();
  const add = (value) => {
    if (typeof value !== 'string' || !value) return;
    const repo = path.resolve(value);
    if (seen.has(repo) || !fs.existsSync(repo)) return;
    seen.add(repo);
    candidates.push(repo);
  };
  add(state && state.workspace);
  for (const repo of (state && Array.isArray(state.registeredWorkspaces) ? state.registeredWorkspaces : [])) add(repo);
  const roots = [];
  const canonical = new Set();
  for (const candidate of candidates) {
    const repo = workspaceRegistry.activeRepoRoot(candidate, { registeredRepos: candidates });
    if (!repo || canonical.has(repo)) continue;
    canonical.add(repo);
    roots.push(repo);
  }
  return roots;
}

function onboardingArtifact(repo) {
  for (const entry of supportedOnboardOutDirs(repo)) {
    const statusFile = path.join(entry.outDir, 'onboard-drain-status.json');
    const queueFile = path.join(entry.outDir, 'onboard-queue.json');
    // Current onboarding uses the default .zonoid path. Legacy roots are accepted only when they
    // carry route metadata; a stray benchmark/fixture queue must not register an index lifecycle.
    if (fs.existsSync(statusFile) || (entry.kind === 'default' && fs.existsSync(queueFile))) {
      return { ...entry, statusFile, queueFile };
    }
  }
  return null;
}

function onboardingComplete(outDir) {
  const status = readOnboardStatus(outDir);
  if (status.injectionState === 'succeeded' || status.injectionState === 'not_needed' || status.injected === true) {
    return true;
  }
  const queue = readOnboardQueue(outDir);
  const valid = validateOnboardQueue(queue, { allowLegacy: true });
  return valid.ok && count(queue.cursor) >= count(queue.total)
    && status.preparationState !== 'pending'
    && status.preparationState !== 'running'
    && status.injectionState !== 'running'
    && status.injectionState !== 'backoff';
}

function liveCodeIndexLease(status, now = Date.now(), alive = pidAlive) {
  const live = status.codeIndexState === 'running'
    && alive(status.codeIndexPid)
    && Number(status.codeIndexLeaseExpiresAt) > now;
  return { live, retryAt: live ? Number(status.codeIndexLeaseExpiresAt) : null };
}

function retryDelay(attempt) {
  const base = Math.max(1, Number(process.env.HEADLESS_CODE_INDEX_RETRY_BASE_MS) || DEFAULT_RETRY_BASE_MS);
  const cap = Math.max(base, Number(process.env.HEADLESS_CODE_INDEX_RETRY_CAP_MS) || DEFAULT_RETRY_CAP_MS);
  return Math.min(cap, base * Math.pow(2, Math.max(0, count(attempt) - 1)));
}

function onboardingGraceMs() {
  const raw = process.env.HEADLESS_CODE_INDEX_ONBOARD_GRACE_MS;
  return raw === undefined ? DEFAULT_ONBOARD_GRACE_MS : Math.max(0, Number(raw) || 0);
}

function onboardingRecentlySettled(status, now = Date.now()) {
  const raw = status && (status.injectedAt || status.preparationCompletedAt || status.updatedAt);
  const settledAt = raw ? Date.parse(raw) : NaN;
  return Number.isFinite(settledAt) && now - settledAt < onboardingGraceMs();
}

function reconcileWatermarkedStatus(outDir, repo, watermark, now = Date.now()) {
  return mutateOnboardStatus(outDir, (status) => {
    if (status.codeIndexState === 'succeeded' && status.codeIndexHead === watermark) return undefined;
    return {
      ...status,
      repo,
      outDir,
      codeIndexState: 'succeeded',
      codeIndexMode: status.codeIndexMode || 'full',
      codeIndexHead: watermark,
      codeIndexOwner: null,
      codeIndexPid: null,
      codeIndexLeaseExpiresAt: null,
      codeIndexRetryAt: null,
      codeIndexError: null,
      codeIndexCompletedAt: status.codeIndexCompletedAt || new Date(now).toISOString(),
    };
  });
}

function reconcileSucceededFullIndexWatermark(repo, overlay, status, opts = {}) {
  const getWatermark = opts.getLastIndexedCommit || overlayStore.getLastIndexedCommit;
  const existing = getWatermark(overlay, repo);
  if (status.codeIndexState !== 'succeeded' || !status.codeIndexHead) return existing;
  const watermark = String(status.codeIndexHead).trim();
  if (!watermark) return existing;
  if (existing === watermark) return watermark;
  const setWatermark = opts.setLastIndexedCommit || overlayStore.setLastIndexedCommit;
  const saveOverlay = opts.saveOverlay || overlayStore.save;
  setWatermark(overlay, repo, watermark);
  saveOverlay(repo, overlay);
  return watermark;
}

function findDueFullIndexJobs(state, opts = {}) {
  const loadOverlay = opts.loadOverlay || overlayStore.load;
  const readStatus = opts.readStatus || readOnboardStatus;
  const headFor = opts.gitHead || gitHead;
  const now = opts.now == null ? Date.now() : Number(opts.now);
  const alive = opts.pidAlive || pidAlive;
  const jobs = [];

  for (const repo of registeredRepos(state)) {
    const artifact = onboardingArtifact(repo);
    if (!artifact || !onboardingComplete(artifact.outDir)) continue;
    const head = headFor(repo);
    if (!head) continue;
    let overlay;
    try { overlay = loadOverlay(repo); } catch { continue; }
    const status = readStatus(artifact.outDir) || {};
    const watermark = reconcileSucceededFullIndexWatermark(repo, overlay, status, opts);
    if (watermark) {
      if (watermark === head) reconcileWatermarkedStatus(artifact.outDir, repo, watermark, now);
      continue;
    }
    if (!status.codeIndexState && onboardingRecentlySettled(status, now)) continue;
    if (liveCodeIndexLease(status, now, alive).live) continue;
    if (status.codeIndexState === 'failed' && Number(status.codeIndexRetryAt) > now) continue;
    jobs.push({ repo, workspace: repo, outDir: artifact.outDir, head, status });
  }
  return jobs;
}

function findDueIncrementalIndexJobs(state, opts = {}) {
  const loadOverlay = opts.loadOverlay || overlayStore.load;
  const readStatus = opts.readStatus || readOnboardStatus;
  const headFor = opts.gitHead || gitHead;
  const now = opts.now == null ? Date.now() : Number(opts.now);
  const alive = opts.pidAlive || pidAlive;
  const jobs = [];

  for (const repo of registeredRepos(state)) {
    const artifact = onboardingArtifact(repo);
    if (!artifact || !onboardingComplete(artifact.outDir)) continue;
    const head = headFor(repo);
    if (!head) continue;
    let overlay;
    try { overlay = loadOverlay(repo); } catch { continue; }
    const status = readStatus(artifact.outDir) || {};
    const watermark = reconcileSucceededFullIndexWatermark(repo, overlay, status, opts);
    if (!watermark) continue; // The full-index discovery path owns first-time onboarding.
    if (watermark === head) {
      reconcileWatermarkedStatus(artifact.outDir, repo, watermark, now);
      continue;
    }
    if (liveCodeIndexLease(status, now, alive).live) continue;
    const sameFailedHead = status.codeIndexState === 'failed'
      && status.codeIndexMode === 'sync'
      && status.codeIndexHead === head;
    if (sameFailedHead && Number(status.codeIndexRetryAt) > now) continue;
    jobs.push({ repo, workspace: repo, outDir: artifact.outDir, from: watermark, head, status });
  }
  return jobs;
}

function claimFullIndex(job, { owner, timeoutMs, now = Date.now(), pid = process.pid, pidAlive: alive = pidAlive } = {}) {
  const attempt = count(job.status && job.status.codeIndexAttempts) + 1;
  const leaseExpiresAt = now + Math.max(1000, Number(timeoutMs) || 0);
  const result = mutateOnboardStatus(job.outDir, (status) => {
    if (liveCodeIndexLease(status, now, alive).live) return undefined;
    if (status.codeIndexState === 'failed' && Number(status.codeIndexRetryAt) > now) return undefined;
    return {
      ...status,
      repo: job.repo,
      outDir: job.outDir,
      codeIndexState: 'running',
      codeIndexMode: 'full',
      codeIndexHead: job.head,
      codeIndexOwner: owner,
      codeIndexPid: pid,
      codeIndexAttempts: attempt,
      codeIndexStartedAt: new Date(now).toISOString(),
      codeIndexLeaseExpiresAt: leaseExpiresAt,
      codeIndexRetryAt: null,
      codeIndexError: null,
    };
  });
  return { ...result, attempt, leaseExpiresAt };
}

function statusOwnedBy(status, owner, head) {
  return status.codeIndexState === 'running'
    && status.codeIndexOwner === owner
    && status.codeIndexHead === head;
}

function completeFullIndex(job, owner, result, now = Date.now()) {
  const counts = {
    symbols: count(result && result.symbols),
    created: count(result && result.created),
    edges: count(result && result.edges),
    edges_added: count(result && result.edges_added),
    batches: count(result && result.batches),
  };
  return mutateOnboardStatus(job.outDir, (status) => {
    if (!statusOwnedBy(status, owner, job.head)) return undefined;
    return {
      ...status,
      codeIndexState: 'succeeded',
      codeIndexMode: 'full',
      codeIndexHead: result.head || job.head,
      codeIndexCounts: counts,
      codeIndexOwner: null,
      codeIndexPid: null,
      codeIndexLeaseExpiresAt: null,
      codeIndexRetryAt: null,
      codeIndexError: null,
      codeIndexCompletedAt: new Date(now).toISOString(),
    };
  });
}

function failFullIndex(job, owner, error, now = Date.now()) {
  return mutateOnboardStatus(job.outDir, (status) => {
    if (!statusOwnedBy(status, owner, job.head)) return undefined;
    const attempt = Math.max(1, count(status.codeIndexAttempts));
    return {
      ...status,
      codeIndexState: 'failed',
      codeIndexMode: 'full',
      codeIndexOwner: null,
      codeIndexPid: null,
      codeIndexLeaseExpiresAt: null,
      codeIndexRetryAt: now + retryDelay(attempt),
      codeIndexError: String(error || 'full AST indexing failed'),
      codeIndexFailedAt: new Date(now).toISOString(),
    };
  });
}

function claimIncrementalIndex(job, { owner, timeoutMs, now = Date.now(), pid = process.pid, pidAlive: alive = pidAlive } = {}) {
  const attempt = count(job.status && job.status.codeIndexAttempts) + 1;
  const leaseExpiresAt = now + Math.max(1000, Number(timeoutMs) || 0);
  const result = mutateOnboardStatus(job.outDir, (status) => {
    if (liveCodeIndexLease(status, now, alive).live) return undefined;
    const sameFailedHead = status.codeIndexState === 'failed'
      && status.codeIndexMode === 'sync'
      && status.codeIndexHead === job.head;
    if (sameFailedHead && Number(status.codeIndexRetryAt) > now) return undefined;
    return {
      ...status,
      repo: job.repo,
      outDir: job.outDir,
      codeIndexState: 'running',
      codeIndexMode: 'sync',
      codeIndexFrom: job.from,
      codeIndexHead: job.head,
      codeIndexOwner: owner,
      codeIndexPid: pid,
      codeIndexAttempts: attempt,
      codeIndexStartedAt: new Date(now).toISOString(),
      codeIndexLeaseExpiresAt: leaseExpiresAt,
      codeIndexRetryAt: null,
      codeIndexError: null,
    };
  });
  return { ...result, attempt, leaseExpiresAt };
}

function completeIncrementalIndex(job, owner, result, now = Date.now()) {
  const counts = {
    changed_files: Array.isArray(result && result.changed_files) ? result.changed_files.length : 0,
    upserted: count(result && result.upserted),
    deleted: count(result && result.deleted),
    files_replaced: count(result && result.files_replaced),
    files_deleted: count(result && result.files_deleted),
    edges_replaced: count(result && result.edges_replaced),
    edges_deleted: count(result && result.edges_deleted),
  };
  return mutateOnboardStatus(job.outDir, (status) => {
    if (!statusOwnedBy(status, owner, job.head) || status.codeIndexMode !== 'sync') return undefined;
    return {
      ...status,
      codeIndexState: 'succeeded',
      codeIndexMode: 'sync',
      codeIndexFrom: result.from || job.from,
      codeIndexHead: result.head || job.head,
      codeIndexCounts: counts,
      codeIndexOwner: null,
      codeIndexPid: null,
      codeIndexLeaseExpiresAt: null,
      codeIndexRetryAt: null,
      codeIndexError: null,
      codeIndexCompletedAt: new Date(now).toISOString(),
    };
  });
}

function failIncrementalIndex(job, owner, error, now = Date.now()) {
  return mutateOnboardStatus(job.outDir, (status) => {
    if (!statusOwnedBy(status, owner, job.head) || status.codeIndexMode !== 'sync') return undefined;
    const attempt = Math.max(1, count(status.codeIndexAttempts));
    return {
      ...status,
      codeIndexState: 'failed',
      codeIndexMode: 'sync',
      codeIndexOwner: null,
      codeIndexPid: null,
      codeIndexLeaseExpiresAt: null,
      codeIndexRetryAt: now + retryDelay(attempt),
      codeIndexError: String(error || 'incremental AST indexing failed'),
      codeIndexFailedAt: new Date(now).toISOString(),
    };
  });
}

function parseIndexResult(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && parsed.mode === 'full') return parsed;
    } catch { /* keep scanning */ }
  }
  return null;
}

function parseSyncResult(stdout) {
  const lines = String(stdout || '').trim().split(/\r?\n/).filter(Boolean);
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const parsed = JSON.parse(lines[i]);
      if (parsed && parsed.mode === 'sync') return parsed;
    } catch { /* keep scanning */ }
  }
  return null;
}

function buildFullIndexArgs(repo, workspace, daemonUrl, expectedHead) {
  return [
    path.join(__dirname, '..', '..', 'scripts', 'onboard-code.js'),
    '--repo', repo,
    '--workspace', workspace,
    '--daemon', daemonUrl,
    '--async',
    '--thin',
    '--json',
    ...(expectedHead ? ['--expected-head', expectedHead] : []),
  ];
}

function buildIncrementalIndexArgs(repo, workspace, daemonUrl, expectedHead) {
  return [
    path.join(__dirname, '..', '..', 'scripts', 'onboard-code.js'),
    '--repo', repo,
    '--workspace', workspace,
    '--daemon', daemonUrl,
    '--sync',
    '--async',
    '--json',
    ...(expectedHead ? ['--expected-head', expectedHead] : []),
  ];
}

function publicCodeIndexStatus(workspace) {
  const artifact = onboardingArtifact(workspace);
  if (!artifact) return null;
  const status = readOnboardStatus(artifact.outDir);
  if (!status.codeIndexState) return null;
  return {
    state: status.codeIndexState,
    mode: status.codeIndexMode || null,
    from: status.codeIndexFrom || null,
    head: status.codeIndexHead || null,
    attempts: count(status.codeIndexAttempts),
    counts: status.codeIndexCounts || null,
    retryable: status.codeIndexState === 'failed',
    retry_at: status.codeIndexRetryAt || null,
    error: status.codeIndexError || null,
    started_at: status.codeIndexStartedAt || null,
    completed_at: status.codeIndexCompletedAt || null,
    failed_at: status.codeIndexFailedAt || null,
  };
}

module.exports = {
  DEFAULT_RETRY_BASE_MS,
  DEFAULT_RETRY_CAP_MS,
  DEFAULT_ONBOARD_GRACE_MS,
  registeredRepos,
  onboardingArtifact,
  onboardingComplete,
  liveCodeIndexLease,
  retryDelay,
  onboardingGraceMs,
  onboardingRecentlySettled,
  reconcileWatermarkedStatus,
  reconcileSucceededFullIndexWatermark,
  findDueFullIndexJobs,
  findDueIncrementalIndexJobs,
  claimFullIndex,
  completeFullIndex,
  failFullIndex,
  claimIncrementalIndex,
  completeIncrementalIndex,
  failIncrementalIndex,
  parseIndexResult,
  parseSyncResult,
  buildFullIndexArgs,
  buildIncrementalIndexArgs,
  publicCodeIndexStatus,
  gitHead,
};
