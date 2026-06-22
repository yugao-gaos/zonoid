'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const TERMINAL = new Set(['done', 'tested', 'failed', 'canceled', 'released']);

function git(repo, args) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    timeout: 10000,
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
  }).trim();
}

function gitSafe(repo, args) {
  try { return git(repo, args); } catch { return null; }
}

function isRepo(repo) {
  return gitSafe(repo, ['rev-parse', '--is-inside-work-tree']) === 'true';
}

function normalizeClaimMode(raw) {
  const value = String(raw == null ? '' : raw).trim().toLowerCase().replace(/_/g, '-');
  if (value === '' || value === 'auto' || value === 'advisory' || value === 'git-advisory') {
    return { mode: 'git', enabled: true, strict: false, explicit: false, valid: true };
  }
  if (value === 'local' || value === 'off' || value === 'false' || value === 'none' || value === 'disabled') {
    return { mode: 'local', enabled: false, strict: false, explicit: true, valid: true };
  }
  if (value === 'git' || value === 'on' || value === 'true') {
    return { mode: 'git', enabled: true, strict: false, explicit: true, valid: true };
  }
  if (value === 'strict' || value === 'git-strict' || value === 'strict-git') {
    return { mode: 'git-strict', enabled: true, strict: true, explicit: true, valid: true };
  }
  return { mode: 'git', enabled: true, strict: false, explicit: false, valid: false, raw: value };
}

function claimMode(overlay) {
  const configured = process.env.ORCH_CLAIM_MODE != null
    ? process.env.ORCH_CLAIM_MODE
    : (overlay && overlay.config && overlay.config.claim_mode);
  const mode = normalizeClaimMode(configured);
  return mode.valid ? mode : normalizeClaimMode('');
}

function claimModeEnabled(overlay) {
  return claimMode(overlay).enabled;
}

function claimModeExplicit(overlay) {
  const mode = claimMode(overlay);
  return mode.enabled && mode.explicit;
}

function claimModeStrict(overlay) {
  return claimMode(overlay).strict;
}

function claimLeaseMinutes(overlay) {
  const mins = overlay && overlay.config && overlay.config.claim_lease_minutes;
  return Number.isFinite(Number(mins)) && Number(mins) > 0 ? Number(mins) : 60;
}

function encodeKey(key) {
  return encodeURIComponent(String(key || '')).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
}

function claimRelPath(taskKey) {
  return path.posix.join('.graph', 'claims', `${encodeKey(taskKey)}.json`);
}

function claimAbsPath(repo, taskKey) {
  return path.join(repo, '.graph', 'claims', `${encodeKey(taskKey)}.json`);
}

function parseJson(s) {
  try { return JSON.parse(s); } catch { return null; }
}

function upstream(repo) {
  return gitSafe(repo, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{u}']);
}

function remoteRef(repo) {
  return upstream(repo) || gitSafe(repo, ['rev-parse', '--abbrev-ref', 'origin/HEAD']);
}

function hasOrigin(repo) {
  return !!gitSafe(repo, ['remote', 'get-url', 'origin']);
}

function shouldAcquire(repo, overlay) {
  const mode = claimMode(overlay);
  if (!mode.enabled) return false;
  return mode.explicit || hasOrigin(repo);
}

function readLocalClaim(repo, taskKey) {
  try { return parseJson(fs.readFileSync(claimAbsPath(repo, taskKey), 'utf8')); } catch { return null; }
}

function readRemoteClaim(repo, taskKey) {
  const up = remoteRef(repo);
  if (!up) return null;
  return parseJson(gitSafe(repo, ['show', `${up}:${claimRelPath(taskKey)}`]));
}

function liveClaim(claim, nowMs = Date.now()) {
  if (!claim || TERMINAL.has(String(claim.status || 'claimed'))) return false;
  const until = Date.parse(claim.lease_until || '');
  return Number.isNaN(until) || until > nowMs;
}

function nonEmpty(raw) {
  const value = String(raw == null ? '' : raw).trim();
  return value || null;
}

function formatGitUser(name, email) {
  const n = nonEmpty(name);
  const e = nonEmpty(email);
  if (n && e) return `${n} <${e}>`;
  if (n) return n;
  if (e) return `<${e}>`;
  return null;
}

function resolveGitUser(repo) {
  return formatGitUser(
    gitSafe(repo, ['config', 'user.name']),
    gitSafe(repo, ['config', 'user.email'])
  );
}

function lockIdentity(repo, opts = {}) {
  return {
    git_user: nonEmpty(opts.gitUser) || resolveGitUser(repo),
    session_id: nonEmpty(opts.sessionId),
  };
}

function hasLockIdentity(identity) {
  return !!(identity && identity.git_user && identity.session_id);
}

function sameLockIdentity(claim, identity) {
  if (!claim || !hasLockIdentity(identity)) return false;
  return nonEmpty(claim.git_user) === identity.git_user
    && nonEmpty(claim.session_id) === identity.session_id;
}

function lockIdentityError(identity) {
  const missing = [];
  if (!identity || !identity.git_user) missing.push('git_user');
  if (!identity || !identity.session_id) missing.push('session_id');
  return `git claim lock identity missing ${missing.join(' and ')}`;
}

function makeClaim(taskKey, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const leaseMs = Math.max(1, Number(opts.leaseMinutes || 60)) * 60000;
  return {
    task_key: String(taskKey),
    git_user: nonEmpty(opts.gitUser) || null,
    session_id: nonEmpty(opts.sessionId) || null,
    branch: opts.branch || null,
    status: 'claimed',
    claimed_at: now.toISOString(),
    lease_until: new Date(now.getTime() + leaseMs).toISOString(),
  };
}

function ensureIdentity(repo) {
  if (!gitSafe(repo, ['config', 'user.name'])) git(repo, ['config', 'user.name', 'orchestrator']);
  if (!gitSafe(repo, ['config', 'user.email'])) git(repo, ['config', 'user.email', 'orchestrator@localhost']);
}

function commitPath(repo, relPath, message) {
  ensureIdentity(repo);
  git(repo, ['add', '--', relPath]);
  const staged = gitSafe(repo, ['diff', '--cached', '--name-only', '--', relPath]);
  if (!staged) return { committed: false };
  git(repo, ['commit', '-m', message, '--', relPath]);
  return { committed: true, head: gitSafe(repo, ['rev-parse', 'HEAD']) };
}

function push(repo) {
  if (upstream(repo)) return git(repo, ['push', '--no-verify']);
  return git(repo, ['push', '--no-verify', '-u', 'origin', 'HEAD']);
}

function acquire(repo, taskKey, opts = {}) {
  if (!repo || !isRepo(repo)) return { ok: false, error: 'git claim mode requires a git repo' };
  if (!hasOrigin(repo)) return { ok: false, error: 'git claim mode requires remote "origin"' };

  gitSafe(repo, ['fetch', 'origin']);
  const identity = lockIdentity(repo, opts);
  const remoteClaim = readRemoteClaim(repo, taskKey);
  if (liveClaim(remoteClaim, opts.nowMs) && !sameLockIdentity(remoteClaim, identity)) {
    return { ok: false, conflict: true, error: 'task already claimed in git', claim: remoteClaim };
  }
  if (liveClaim(remoteClaim, opts.nowMs) && sameLockIdentity(remoteClaim, identity)) {
    return { ok: true, already_claimed: true, claim: remoteClaim };
  }
  if (!hasLockIdentity(identity)) {
    return { ok: false, conflict: true, error: lockIdentityError(identity) };
  }

  const localClaim = readLocalClaim(repo, taskKey);
  if (liveClaim(localClaim, opts.nowMs) && !sameLockIdentity(localClaim, identity)) {
    return { ok: false, conflict: true, error: 'task already claimed locally', claim: localClaim };
  }

  const rel = claimRelPath(taskKey);
  const abs = claimAbsPath(repo, taskKey);
  const claim = makeClaim(taskKey, { ...opts, gitUser: identity.git_user, sessionId: identity.session_id });
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(claim, null, 2) + '\n');
  const commit = commitPath(repo, rel, `claim ${taskKey}`);

  try {
    push(repo);
    return { ok: true, claim, committed: commit.committed, pushed: true };
  } catch (e) {
    gitSafe(repo, ['fetch', 'origin']);
    const after = readRemoteClaim(repo, taskKey);
    if (liveClaim(after, opts.nowMs) && sameLockIdentity(after, identity)) {
      return { ok: true, already_claimed: true, claim: after };
    }
    if (liveClaim(after, opts.nowMs)) {
      return { ok: false, conflict: true, error: 'task already claimed in git', claim: after };
    }
    return { ok: false, error: 'git claim push failed', detail: String(e.stderr || e.message || e).slice(0, 500) };
  }
}

function finalize(repo, taskKey, opts = {}) {
  if (!repo || !isRepo(repo)) {
    return opts.strict
      ? { ok: false, error: 'git claim mode requires a git repo' }
      : { ok: true, skipped: true };
  }
  if (!hasOrigin(repo)) {
    return opts.strict
      ? { ok: false, error: 'git claim mode requires remote "origin"' }
      : { ok: true, skipped: true };
  }
  gitSafe(repo, ['fetch', 'origin']);
  const identity = lockIdentity(repo, opts);
  const remoteClaim = readRemoteClaim(repo, taskKey);
  if (liveClaim(remoteClaim, opts.nowMs) && !sameLockIdentity(remoteClaim, identity)) {
    return { ok: false, conflict: true, error: 'task claimed by another agent in git', claim: remoteClaim };
  }
  if (opts.strict && !hasLockIdentity(identity)) {
    return { ok: false, conflict: true, error: lockIdentityError(identity) };
  }
  const existing = readLocalClaim(repo, taskKey) || readRemoteClaim(repo, taskKey) || {};
  const claim = {
    ...existing,
    task_key: String(taskKey),
    git_user: identity.git_user || existing.git_user || null,
    session_id: identity.session_id || existing.session_id || null,
    status: opts.status || 'released',
    completed_at: new Date().toISOString(),
  };
  delete claim.agent_id;
  delete claim.workspace;
  const rel = claimRelPath(taskKey);
  const abs = claimAbsPath(repo, taskKey);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(claim, null, 2) + '\n');
  try {
    const commit = commitPath(repo, rel, `release claim ${taskKey}`);
    if (commit.committed) push(repo);
    return { ok: true, claim, pushed: !!commit.committed };
  } catch (e) {
    return { ok: false, error: 'git claim release push failed', detail: String(e.stderr || e.message || e).slice(0, 500) };
  }
}

module.exports = {
  acquire,
  claimMode,
  claimModeEnabled,
  claimModeExplicit,
  claimModeStrict,
  claimLeaseMinutes,
  claimRelPath,
  finalize,
  hasOrigin,
  liveClaim,
  makeClaim,
  normalizeClaimMode,
  resolveGitUser,
  shouldAcquire,
};
