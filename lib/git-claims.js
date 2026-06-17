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

function claimModeEnabled(overlay) {
  const mode = process.env.ORCH_CLAIM_MODE || (overlay && overlay.config && overlay.config.claim_mode);
  const normalized = String(mode || '').toLowerCase();
  if (normalized === 'local' || normalized === 'off' || normalized === 'false') return false;
  return normalized === '' || normalized === 'git';
}

function claimModeExplicit(overlay) {
  const mode = process.env.ORCH_CLAIM_MODE || (overlay && overlay.config && overlay.config.claim_mode);
  return String(mode || '').toLowerCase() === 'git';
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
  if (!claimModeEnabled(overlay)) return false;
  return claimModeExplicit(overlay) || hasOrigin(repo);
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

function makeClaim(taskKey, opts = {}) {
  const now = opts.now ? new Date(opts.now) : new Date();
  const leaseMs = Math.max(1, Number(opts.leaseMinutes || 60)) * 60000;
  return {
    task_key: String(taskKey),
    agent_id: opts.agentId || null,
    session_id: opts.sessionId || null,
    workspace: opts.workspace || null,
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
  if (upstream(repo)) return git(repo, ['push']);
  return git(repo, ['push', '-u', 'origin', 'HEAD']);
}

function acquire(repo, taskKey, opts = {}) {
  if (!repo || !isRepo(repo)) return { ok: false, error: 'git claim mode requires a git repo' };
  if (!hasOrigin(repo)) return { ok: false, error: 'git claim mode requires remote "origin"' };

  gitSafe(repo, ['fetch', 'origin']);
  const remoteClaim = readRemoteClaim(repo, taskKey);
  if (liveClaim(remoteClaim, opts.nowMs) && remoteClaim.agent_id && remoteClaim.agent_id !== opts.agentId) {
    return { ok: false, conflict: true, error: 'task already claimed in git', claim: remoteClaim };
  }
  if (liveClaim(remoteClaim, opts.nowMs) && remoteClaim.agent_id === opts.agentId) {
    return { ok: true, already_claimed: true, claim: remoteClaim };
  }

  const localClaim = readLocalClaim(repo, taskKey);
  if (liveClaim(localClaim, opts.nowMs) && localClaim.agent_id && localClaim.agent_id !== opts.agentId) {
    return { ok: false, conflict: true, error: 'task already claimed locally', claim: localClaim };
  }

  const rel = claimRelPath(taskKey);
  const abs = claimAbsPath(repo, taskKey);
  const claim = makeClaim(taskKey, opts);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, JSON.stringify(claim, null, 2) + '\n');
  const commit = commitPath(repo, rel, `claim ${taskKey}`);

  try {
    push(repo);
    return { ok: true, claim, committed: commit.committed, pushed: true };
  } catch (e) {
    gitSafe(repo, ['fetch', 'origin']);
    const after = readRemoteClaim(repo, taskKey);
    if (liveClaim(after, opts.nowMs) && after.agent_id !== opts.agentId) {
      return { ok: false, conflict: true, error: 'task already claimed in git', claim: after };
    }
    return { ok: false, error: 'git claim push failed', detail: String(e.stderr || e.message || e).slice(0, 500) };
  }
}

function finalize(repo, taskKey, opts = {}) {
  if (!repo || !isRepo(repo) || !hasOrigin(repo)) return { ok: true, skipped: true };
  const existing = readLocalClaim(repo, taskKey) || readRemoteClaim(repo, taskKey) || {};
  const claim = {
    ...existing,
    task_key: String(taskKey),
    agent_id: opts.agentId || existing.agent_id || null,
    status: opts.status || 'released',
    completed_at: new Date().toISOString(),
  };
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
  claimModeEnabled,
  claimModeExplicit,
  claimLeaseMinutes,
  claimRelPath,
  finalize,
  hasOrigin,
  liveClaim,
  makeClaim,
  shouldAcquire,
};
