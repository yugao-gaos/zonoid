'use strict';
/**
 * headless-drain.js — daemon-internal runner + governor for headless drain processes.
 *
 * DESIGN
 * ------
 * Enables the passive daemon (no live session) to run background maintenance tasks through Node
 * scripts, the selected agentic CLI backend, or an in-process API backend instead of dispatching to
 * an interactive agent session.
 * This is the "no-session path": real ready-task impl work remains session-dispatched; this module
 * only handles standing background drains (learner, and later judge/label).
 *
 * SAFETY GATE
 * -----------
 * Headless drains are enabled by default. Set `ORCH_HEADLESS_DRAINS=0`, `false`, or `no` to make
 * the runner a strict no-op. The governor below is the primary fork-bomb guard.
 *
 * GOVERNOR
 * --------
 * Mirrors the shape of AUTOSTART_CONFIG in lib/loop-autostart.js:
 *   tokenBudget     — max tokens the headless drain pool may spend per daemon lifetime (soft cap;
 *                     the spawned process reports usage back via stdout JSON when available).
 *   maxIterations   — max individual drain runs across all drains (hard cap on spawn count).
 *   maxConcurrency  — max simultaneously running drain child processes (fork-bomb guard).
 *   timeoutMs       — per-run wall-clock timeout; the child is SIGKILL'd after this.
 *
 * USAGE
 * -----
 *   const hd = require('./headless-drain');
 *   // Called once from the daemon's setInterval trigger:
 *   hd.runDueDrains(state, overlayStore);
 *
 * EXPORTS
 * -------
 *   HEADLESS_DRAIN_CONFIG  — default governor config (mirrors AUTOSTART_CONFIG shape).
 *   isHeadlessEnabled()    — false only for explicit ORCH_HEADLESS_DRAINS opt-out values.
 *   runDrain(spec)         — spawn one drain child and return { exitCode, stdout, timedOut }.
 *   runDueDrains(state, ov) — check governor budget/concurrency and run any due drains.
 *   _governor              — mutable governor state (exported for tests / reset between runs).
 */

const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const path = require('path');
const http = require('http');
const { loadEnvForClaude, needsShell } = require('./claude-cli');
const { runtimePath } = require('./runtime-paths');
const {
  defaultOnboardOutDir,
  onboardRuntimeRoot,
  legacyBenchOnboardRoot,
  legacyGraphOnboardOutDir,
} = require('./onboard-paths');

// ---- constants -----------------------------------------------------------------------

const SELF_REPO = path.resolve(__dirname, '..');

// Default governor config — mirrors AUTOSTART_CONFIG shape from lib/loop-autostart.js.
// These are conservative defaults; override via HEADLESS_DRAIN_* env vars (see below).
const HEADLESS_DRAIN_CONFIG = {
  tokenBudget: 200000,      // max tokens the drain pool may spend per daemon boot (soft)
  maxIterations: 50,        // legacy explicit-cap fallback; normal daemon default is unbounded
  maxConcurrency: 4,        // max simultaneously running drain child processes. Was 12, but 12
                            // concurrent agentic-cli claude.exe judges (each ~8s startup) hammering
                            // the single-threaded daemon's HTTP listener (judge/next + judge/verdict
                            // + .graph commits) saturated it within minutes. 4 keeps the listener
                            // responsive while still draining the backlog (override via HEADLESS_DRAIN_MAX_CONCURRENCY).
  timeoutMs: 5 * 60 * 1000, // per-run wall-clock timeout (5 min). NOTE: f290885f dropped the `60 *`
                            // here (10min → 5s), SIGKILLing the agentic claude.exe judge mid-boot
                            // (~8s just to start) — 100% judge-drain timeout. The fast node label/
                            // learner drains masked it. Keep this in MINUTES; the lease floor below
                            // (Math.max(60_000, …)) assumes a ≥60s run.
};

const DEFAULT_JUDGE_DRAIN_BUDGET = 20;
const DEFAULT_LEARNER_DRAIN_BATCH = DEFAULT_JUDGE_DRAIN_BUDGET;
const DEFAULT_LEARNER_TIMEOUT_MS = 10 * 60 * 1000;

// ---- explicit opt-out safety gate ----------------------------------------------------

/**
 * Returns true unless ORCH_HEADLESS_DRAINS is an explicit opt-out value.
 * When this returns false, runDrain() and runDueDrains() are strict no-ops.
 */
function isHeadlessEnabled() {
  try {
    if (process.env.HEADLESS_DRAIN_IGNORE_MARKER !== '1'
        && fs.existsSync(path.join(SELF_REPO, '.headless-drains-off'))) return false;
  } catch { /* best-effort marker check */ }
  const v = process.env.ORCH_HEADLESS_DRAINS;
  if (v === undefined) return true;
  const normalized = String(v).trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'no';
}

// ---- host-wide drain lease -----------------------------------------------------------
// _governor.concurrentRunning is intentionally process-local. The daemon can be launched by more
// than one adapter hook, so every heavyweight drain also takes a host-wide slot in the runtime data
// dir. That keeps HEADLESS_DRAIN_MAX_CONCURRENCY meaningful across daemon copies.

const DRAIN_LEASE_LOCK_STALE_MS = 30 * 1000;

function drainLeaseFile() {
  return process.env.HEADLESS_DRAIN_LEASE_FILE
    ? path.resolve(process.env.HEADLESS_DRAIN_LEASE_FILE)
    : runtimePath('headless-drain-leases.json');
}

function globalLeaseEnabled() {
  const v = process.env.HEADLESS_DRAIN_GLOBAL_LEASE;
  if (v === undefined) return true;
  const normalized = String(v).trim().toLowerCase();
  return normalized !== '0' && normalized !== 'false' && normalized !== 'no';
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

function readLeaseState(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    return { version: 1, leases: Array.isArray(parsed.leases) ? parsed.leases : [] };
  } catch {
    return { version: 1, leases: [] };
  }
}

function writeLeaseState(file, state) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, leases: state.leases || [] }, null, 2));
  fs.renameSync(tmp, file);
}

function withLeaseLock(fn, fallback) {
  const file = drainLeaseFile();
  const lockFile = `${file}.lock`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let fd = null;
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      fd = fs.openSync(lockFile, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
      break;
    } catch (err) {
      if (!err || err.code !== 'EEXIST') return fallback;
      try {
        const st = fs.statSync(lockFile);
        if (Date.now() - st.mtimeMs > DRAIN_LEASE_LOCK_STALE_MS) {
          fs.unlinkSync(lockFile);
          continue;
        }
      } catch { /* retry once if the lock disappeared */ }
      return fallback;
    }
  }
  if (fd == null) return fallback;
  try {
    return fn(file);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lockFile); } catch { /* ignore */ }
  }
}

function pruneLiveLeases(leases, nowMs) {
  return (Array.isArray(leases) ? leases : []).filter((lease) => {
    if (!lease || !lease.id) return false;
    if (Number(lease.expiresAt || 0) <= nowMs) return false;
    return pidAlive(lease.pid);
  });
}

function releaseGlobalDrainSlot(id) {
  if (!id || !globalLeaseEnabled()) return false;
  return withLeaseLock((file) => {
    const state = readLeaseState(file);
    const before = state.leases.length;
    state.leases = state.leases.filter((lease) => lease && lease.id !== id);
    if (state.leases.length !== before) writeLeaseState(file, state);
    return state.leases.length !== before;
  }, false);
}

function acquireGlobalDrainSlot(cfg, kind) {
  if (!globalLeaseEnabled()) {
    return { ok: true, disabled: true, release() {} };
  }
  const max = Math.max(1, Number(cfg && cfg.maxConcurrency) || HEADLESS_DRAIN_CONFIG.maxConcurrency);
  const timeoutMs = Math.max(60_000, Number(cfg && cfg.timeoutMs) || HEADLESS_DRAIN_CONFIG.timeoutMs);
  return withLeaseLock((file) => {
    const now = Date.now();
    const state = readLeaseState(file);
    state.leases = pruneLiveLeases(state.leases, now);
    if (state.leases.length >= max) {
      writeLeaseState(file, state);
      return { ok: false, reason: 'global_concurrency_cap', running: state.leases.length, max };
    }
    const id = `${process.pid}:${now}:${Math.random().toString(36).slice(2)}`;
    state.leases.push({
      id,
      pid: process.pid,
      kind: String(kind || 'drain'),
      startedAt: now,
      expiresAt: now + timeoutMs + 60_000,
    });
    writeLeaseState(file, state);
    return { ok: true, id, release: () => releaseGlobalDrainSlot(id) };
  }, { ok: false, reason: 'global_lease_lock_busy', running: null, max });
}

// ---- mutable governor state ----------------------------------------------------------
// Exported so tests can reset it between runs without re-requiring the module.

const _governor = {
  iterationsUsed: 0,
  tokensUsed: 0,
  concurrentRunning: 0,
  backoffUntil: 0,          // ms epoch; runDueDrains no-ops while Date.now() < this (rate-limit/overload backoff)
  consecutiveThrottles: 0,  // grows the backoff window per consecutive throttle; reset on a clean run
};

const _activeDetachedLabels = new Set();

// ---- effective config ----------------------------------------------------------------

function effectiveConfig() {
  const maxIterationsEnv = process.env.HEADLESS_DRAIN_MAX_ITERATIONS;
  const maxIterations = maxIterationsEnv === undefined || maxIterationsEnv === ''
    ? Number.POSITIVE_INFINITY
    : (Number(maxIterationsEnv) || HEADLESS_DRAIN_CONFIG.maxIterations);
  return {
    tokenBudget: Number(process.env.HEADLESS_DRAIN_TOKEN_BUDGET) || HEADLESS_DRAIN_CONFIG.tokenBudget,
    maxIterations,
    maxConcurrency: Number(process.env.HEADLESS_DRAIN_MAX_CONCURRENCY) || HEADLESS_DRAIN_CONFIG.maxConcurrency,
    timeoutMs: Number(process.env.HEADLESS_DRAIN_TIMEOUT_MS) || HEADLESS_DRAIN_CONFIG.timeoutMs,
  };
}

// ---- rate-limit / overload backoff ---------------------------------------------------
// The drains call a metered LLM API; under 429/529/overload they should briefly yield, but the
// daemon's slot-refill pump should not stall for minutes. Keep the default retry window short and
// fixed; operators can still raise it via HEADLESS_DRAIN_BACKOFF_* if needed.
const BACKOFF_BASE_MS = 5 * 1000;         // first backoff window
const BACKOFF_CAP_MS = 5 * 1000;          // max backoff window

function backoffConfig() {
  return {
    baseMs: Number(process.env.HEADLESS_DRAIN_BACKOFF_BASE_MS) || BACKOFF_BASE_MS,
    capMs: Number(process.env.HEADLESS_DRAIN_BACKOFF_CAP_MS) || BACKOFF_CAP_MS,
  };
}

// True iff a runDrain result looks rate-limited / overloaded (429, 529, "overloaded", "rate limit",
// "too many requests", "quota" — also catches stream-json error events carrying those). Pure.
function isThrottled(result) {
  if (!result) return false;
  const hay = `${result.stderr || ''}\n${result.stdout || ''}`;
  return /\b(429|529)\b|overloaded|rate[ _-]?limit|too many requests|quota/i.test(hay);
}

// Fold one LLM-drain outcome into the governor's backoff: a throttle, timeout, spawn error, or
// non-zero exit grows the window (capped); a clean run (exit 0, not timed out, not throttled)
// RESETS it. Pure mutation on _governor; nowMs injected for tests. NOTE: only call this for
// LLM-backed drains (learner/judge) — NOT the deterministic label drain, which never hits the API
// and so must not reset an LLM backoff.
function recordDrainOutcome(result, nowMs = Date.now()) {
  if (!result) return;
  const failed = !!result.spawnError || (
    result.exitCode !== undefined
    && result.exitCode !== null
    && result.exitCode !== 0
  );
  if (isThrottled(result) || result.timedOut || failed) {
    _governor.consecutiveThrottles += 1;
    const { baseMs, capMs } = backoffConfig();
    _governor.backoffUntil = nowMs + Math.min(capMs, baseMs * Math.pow(2, _governor.consecutiveThrottles - 1));
  } else if (result.exitCode === 0) {
    _governor.consecutiveThrottles = 0;
    _governor.backoffUntil = 0;
  }
}

// ---- git snapshot commits -------------------------------------------------------------

function gitCapture(repo, args, opts = {}) {
  return execFileSync('git', ['-C', repo, ...args], {
    encoding: 'utf8',
    windowsHide: true,
    stdio: opts.stdio || ['ignore', 'pipe', 'pipe'],
    env: opts.env || process.env,
  }).trim();
}

function gitSafe(repo, args, opts = {}) {
  try {
    return { ok: true, stdout: gitCapture(repo, args, opts) };
  } catch (err) {
    return {
      ok: false,
      code: err && err.status,
      stderr: String((err && err.stderr) || (err && err.message) || err || ''),
    };
  }
}

function ensureGitIdentity(repo) {
  if (!gitSafe(repo, ['config', 'user.name']).stdout) {
    gitSafe(repo, ['config', 'user.name', 'orchestrator']);
  }
  if (!gitSafe(repo, ['config', 'user.email']).stdout) {
    gitSafe(repo, ['config', 'user.email', 'orchestrator@localhost']);
  }
}

/**
 * Commit daemon-owned graph artifacts after a clean headless drain.
 *
 * This intentionally stages only `.graph` and commits with a `.graph` pathspec so a drain never
 * sweeps unrelated user work into the snapshot. Failures are returned, not thrown: graph commits are
 * durability/audit, not part of the drain's success criteria.
 */
function commitGraphSnapshot(repoPath, label) {
  const repo = path.resolve(repoPath || SELF_REPO);
  if (gitSafe(repo, ['rev-parse', '--is-inside-work-tree']).stdout !== 'true') {
    return { committed: false, reason: 'not_git_repo' };
  }
  const root = gitSafe(repo, ['rev-parse', '--show-toplevel']).stdout || repo;
  if (!fs.existsSync(path.join(root, '.graph'))) {
    return { committed: false, reason: 'no_graph_dir' };
  }

  ensureGitIdentity(root);
  const add = gitSafe(root, ['add', '-A', '--', '.graph']);
  if (!add.ok) return { committed: false, reason: 'git_add_failed', error: add.stderr };

  const quiet = gitSafe(root, ['diff', '--cached', '--quiet', '--', '.graph']);
  if (quiet.ok) return { committed: false, reason: 'no_graph_changes' };
  if (quiet.code !== 1 && quiet.code !== undefined) {
    return { committed: false, reason: 'git_diff_failed', error: quiet.stderr };
  }

  const msg = `chore: ${label || 'headless drain'} graph snapshot`;
  const env = { ...process.env, ORCH_GRAPH_AUTOCOMMIT: '0' };
  const commit = gitSafe(root, ['commit', '--no-verify', '-m', msg, '--', '.graph'], { env });
  if (!commit.ok) return { committed: false, reason: 'git_commit_failed', error: commit.stderr };

  const head = gitSafe(root, ['rev-parse', '--short', 'HEAD']).stdout || null;
  return { committed: true, head, message: msg };
}

// ---- single-drain runner -------------------------------------------------------------

/**
 * Spawn one headless drain run ASYNCHRONOUSLY and resolve when the child exits.
 *
 * @param {object} spec
 *   @param {string}   spec.bin     — absolute path or command name for the drain executable
 *   @param {string[]} spec.args    — argv passed to `claude` (e.g. ['-p', prompt, ...])
 *   @param {string}   spec.cwd     — working directory for the child
 *   @param {number}   spec.timeoutMs — wall-clock timeout; child is SIGKILL'd after this
 *
 * @returns {Promise<{ exitCode: number|null, stdout: string, stderr: string, timedOut: boolean, spawnError: string|null }>}
 *
 * NON-BLOCKING (the whole point of this module's deadlock fix): uses async `child_process.spawn`,
 * NOT spawnSync. The daemon is single-threaded — spawnSync froze the event loop for the entire
 * child run, so a drain child that calls BACK into the daemon over HTTP (the JUDGE drain hits
 * GET /judge/next + POST /judge/verdict; the LABEL drain hits the daemon too) deadlocked: the
 * child blocked waiting for the daemon, which was blocked inside spawnSync waiting for the child,
 * until the drain timeout SIGKILL'd it. With async spawn the event loop stays free while the
 * child runs, so those callbacks are served and no deadlock can form. The returned Promise:
 *   - accumulates stdout/stderr (capped at maxBuffer, mirroring the old spawnSync cap),
 *   - enforces spec.timeoutMs via an unref'd timer that SIGKILLs the child and resolves timedOut:true,
 *   - resolves on the child's close event (exitCode = the exit code, or null when timed out/killed),
 *   - resolves spawnError on the child's error event (and on a synchronous spawn throw).
 * The timer is unref'd so it never holds the process open.
 *
 * The SAFETY GATE is checked by the caller (runDueDrains). runDrain itself does NOT check
 * isHeadlessEnabled() — callers are responsible for gating.
 */
function runDrain(spec) {
  const { bin, args, cwd, timeoutMs, env } = spec;
  const shell = needsShell(bin);
  const MAX_BUFFER = 32 * 1024 * 1024;

  return new Promise((resolve) => {
    let child;
    try {
      // Forward an explicit env ONLY when the spec carries one (the selectable backend's
      // buildInvocation supplies it); absent ⇒ omit so the child inherits the parent env as before.
      const spawnOpts = { cwd: cwd || SELF_REPO, shell, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] };
      if (env) spawnOpts.env = env;
      child = spawn(bin, args, spawnOpts);
    } catch (err) {
      // Synchronous spawn failure (e.g. bad cwd) — mirror the error-event shape.
      resolve({ exitCode: null, stdout: '', stderr: '', timedOut: false, spawnError: err && err.message ? err.message : String(err) });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;

    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };

    if (child.stdout) {
      child.stdout.setEncoding('utf8');
      child.stdout.on('data', (chunk) => { if (stdout.length < MAX_BUFFER) stdout += chunk; });
    }
    if (child.stderr) {
      child.stderr.setEncoding('utf8');
      child.stderr.on('data', (chunk) => { if (stderr.length < MAX_BUFFER) stderr += chunk; });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      try { child.kill('SIGKILL'); } catch { /* child already gone */ }
    }, timeoutMs);
    if (timer && typeof timer.unref === 'function') timer.unref();

    child.on('error', (err) => {
      finish({ exitCode: null, stdout, stderr, timedOut, spawnError: err && err.message ? err.message : String(err) });
    });
    child.on('close', (code) => {
      finish({ exitCode: timedOut ? null : code, stdout, stderr, timedOut, spawnError: null });
    });
  });
}

// ---- multi-drain orchestrator --------------------------------------------------------

/**
 * Definition of the standing first-party drains wired through this runner.
 *
 * A drain spec has:
 *   key      — the graph task key this drain corresponds to (for dashboard reporting)
 *   buildArgs(...) — returns argv array for the spawned executable
 *   getCwd(...)    — returns the working directory for the spawn
 *
 * The LEARNER drain spawns a Node script (scripts/onboard-learn.js --drain). The JUDGE drain
 * uses the selected LLM backend (agentic CLI or in-process API) to drive the self-learn skill
 * edge-judge mode against the daemon. The LABEL drain spawns a Node script (scripts/gate-label.js)
 * — a DETERMINISTIC labeler, wired exactly like the LEARNER consumer (a Node child through this runner).
 */
const LEARNER_DRAIN_KEY = 'followup/harness-learner-drain';
const ONBOARD_DRAIN_STATUS_FILE = 'onboard-drain-status.json';

// Stable key for the standing "harness: judge drain" task — MUST match routes/judge.js
// HARNESS_JUDGE_DRAIN_KEY so dashboard progress notes attach to the same node the route ensures.
const JUDGE_DRAIN_KEY = 'followup/harness-judge-drain';

// Stable key for the standing "harness: label drain" task — MUST match routes/label.js
// HARNESS_LABEL_DRAIN_KEY so dashboard progress notes attach to the same node the route ensures.
const LABEL_DRAIN_KEY = 'followup/harness-label-drain';
const REVIEW_MERGE_DRAIN_KEY = 'followup/harness-review-merge-drain';

// Default daemon base URL the headless judge drives over HTTP (/judge/next + /judge/verdict).
const DAEMON_BASE_URL = `http://localhost:${Number(process.env.ORCH_PORT) || 8787}`;

function daemonToken() {
  try { return require('./mcp-core').readToken(); } catch { return null; }
}

function postDaemonJson(route, body, httpModule = http) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(route, DAEMON_BASE_URL); } catch (err) {
      resolve({ ok: false, error: err && err.message ? err.message : String(err) });
      return;
    }
    const payload = JSON.stringify(body || {});
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    };
    const token = daemonToken();
    if (token) headers['x-orch-token'] = token;
    const req = httpModule.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        if (res.statusCode >= 400) parsed = { ...parsed, ok: false, status: res.statusCode, error: parsed.error || `HTTP ${res.statusCode}` };
        resolve(parsed);
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err && err.message ? err.message : String(err) }));
    req.end(payload);
  });
}

function reviewStateReadyForMerge(lifecycle) {
  return lifecycle
    && lifecycle.review_state === 'approved'
    && lifecycle.review_verdict === 'APPROVE'
    && (lifecycle.merge_state === 'pending' || lifecycle.merge_state === 'merged');
}

function findReviewMergeCandidates(workspaceRoot, deps = {}) {
  const overlayStore = deps.overlayStore || require('./overlay');
  const overlayLoad = deps.overlayLoad || overlayStore.load;
  const overlay = deps.overlay || overlayLoad(workspaceRoot);
  if (!overlay) return [];
  const graph = deps.graph || (typeof deps.buildGraph === 'function' ? deps.buildGraph(workspaceRoot) : null);
  const graphTasks = graph && Array.isArray(graph.tasks) ? graph.tasks : null;
  const seen = new Set();
  const rows = graphTasks
    ? graphTasks.map((t) => ({ key: t.id, status: t.status }))
    : Object.keys(overlay.status || {}).map((key) => ({ key, status: overlay.status[key] }));
  const out = [];
  for (const row of rows) {
    const key = row && row.key;
    if (!key || seen.has(key) || row.status !== 'tested') continue;
    seen.add(key);
    const lifecycle = overlayStore.reviewLifecycleFor(overlay, key, row.status);
    if (!reviewStateReadyForMerge(lifecycle)) continue;
    out.push({
      key,
      action: lifecycle.merge_state === 'merged' ? 'promote' : 'merge',
      merge_state: lifecycle.merge_state,
      repo_path: overlay.repos && overlay.repos[key] || null,
      merge_sha: lifecycle.merge_sha || null,
    });
  }
  return out;
}

async function runReviewMergeDrain(workspaceRoot, deps = {}) {
  const maxPerTick = Math.max(1, Number(process.env.HEADLESS_DRAIN_REVIEW_MERGE_MAX_PER_TICK) || 20);
  const candidates = findReviewMergeCandidates(workspaceRoot, deps).slice(0, maxPerTick);
  if (!candidates.length) return { ran: 0, drains: [] };
  const mergeTask = deps.mergeTask || ((candidate) => postDaemonJson('/git/merge', {
    workspace: workspaceRoot,
    key: candidate.key,
    repo_path: candidate.repo_path,
    message: `headless review merge: ${candidate.key}`,
  }, deps.httpModule));
  const promoteTask = deps.promoteTask || ((candidate, merge) => postDaemonJson('/overlay/status', {
    workspace: workspaceRoot,
    key: candidate.key,
    status: 'done',
    summary: 'Auto-promoted approved tested attempt after merge.',
    note: 'headless review merge drain',
    agent_id: 'headless-review-merge-drain',
    review: {
      review_state: 'landed',
      review_verdict: 'APPROVE',
      review_agent: 'headless-review-merge-drain',
      review_reason: 'Approved attempt merged by headless review drain.',
      review_note: 'Approved attempt merged by headless review drain.',
      merge_state: 'merged',
      merge_sha: (merge && merge.head) || candidate.merge_sha || null,
    },
  }, deps.httpModule));
  const drains = [];
  for (const candidate of candidates) {
    if (candidate.action === 'promote') {
      const promoted = await promoteTask(candidate, { merged: true, head: candidate.merge_sha || null });
      drains.push({
        drain: REVIEW_MERGE_DRAIN_KEY,
        task: candidate.key,
        action: 'promote',
        promoted: !(promoted && promoted.error),
        error: promoted && promoted.error || null,
      });
      continue;
    }
    const merge = await mergeTask(candidate);
    if (merge && merge.merged === true && !(merge.error || merge.conflict)) {
      const promoted = await promoteTask(candidate, merge);
      drains.push({
        drain: REVIEW_MERGE_DRAIN_KEY,
        task: candidate.key,
        action: 'merge',
        merged: true,
        promoted: !(promoted && promoted.error),
        merge_sha: merge.head || null,
        error: promoted && promoted.error || null,
      });
    } else {
      drains.push({
        drain: REVIEW_MERGE_DRAIN_KEY,
        task: candidate.key,
        action: 'merge',
        merged: false,
        conflict: !!(merge && merge.conflict),
        error: merge && (merge.error || merge.reason) || null,
      });
    }
  }
  return { ran: drains.length, drains };
}

/**
 * Build the argv for the learner drain invocation.
 * Mirrors what `node scripts/onboard-learn.js --drain --repo <abs>` does — but we call
 * `node` directly so the drain runner is not dependent on the system having `node` on PATH
 * (it's the same Node that runs the daemon).
 */
function buildLearnerArgs(repoAbs, outDir, timeoutMs) {
  const script = path.join(SELF_REPO, 'scripts', 'onboard-learn.js');
  const args = [script, '--drain', '--repo', repoAbs];
  if (outDir) args.push('--in', outDir);
  if (timeoutMs) args.push('--timeout-ms', String(timeoutMs));
  return args;
}

/**
 * Find learner queues with pending drain or inject work.
 *
 * Browser onboarding writes queues under .zonoid/onboard/<repo>. Legacy queues may still exist
 * under bench/onboard/<repo> or .graph/onboard, so the daemon must discover all three locations.
 */
function readJSONFile(file, def = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return def; }
}

function writeJSONAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, file);
}

function learnerStatusFile(outDir) {
  return path.join(outDir, ONBOARD_DRAIN_STATUS_FILE);
}

function readLearnerStatus(outDir) {
  return readJSONFile(learnerStatusFile(outDir), {}) || {};
}

function writeLearnerStatus(outDir, patch) {
  const prev = readLearnerStatus(outDir);
  const next = { ...prev, ...patch, updatedAt: new Date().toISOString() };
  writeJSONAtomic(learnerStatusFile(outDir), next);
  return next;
}

function learnerQueueDirs(workspaceRoot) {
  const root = path.resolve(workspaceRoot || SELF_REPO);
  const dirs = [legacyGraphOnboardOutDir(root)];
  for (const parent of [onboardRuntimeRoot(root), legacyBenchOnboardRoot(root)]) {
    try {
      for (const ent of fs.readdirSync(parent, { withFileTypes: true })) {
        if (ent.isDirectory()) dirs.push(path.join(parent, ent.name));
      }
    } catch { /* onboarding queue root may not exist */ }
  }
  return dirs;
}

function learnerQueueFromDir(workspaceRoot, outDir) {
  const qf = path.join(outDir, 'onboard-queue.json');
  const q = readJSONFile(qf, null);
  if (!q || typeof q.cursor !== 'number' || typeof q.total !== 'number') return null;
  const root = workspaceRoot || SELF_REPO;
  const resolvedOutDir = path.resolve(outDir);
  const isLegacyGraphQueue = resolvedOutDir === legacyGraphOnboardOutDir(root);
  const isDefaultRuntimeQueue = resolvedOutDir === defaultOnboardOutDir(root);
  const statusPath = learnerStatusFile(outDir);
  if (!isLegacyGraphQueue && !isDefaultRuntimeQueue && !fs.existsSync(statusPath)) return null;
  const meta = readLearnerStatus(outDir);
  const repo = path.resolve(meta.repo || workspaceRoot);
  const remaining = Math.max(0, q.total - q.cursor);
  const kept = Array.isArray(q.kept) ? q.kept.length : 0;
  const injectedKept = Math.max(0, Number(meta.injectedKept) || 0);
  const autoInject = meta.autoInject !== false;
  const notesFile = path.join(outDir, 'onboard-notes.json');
  const injectDue = autoInject && kept > injectedKept && meta.injecting !== true
    && !meta.error && fs.existsSync(notesFile);
  if (remaining <= 0 && !injectDue) return null;
  return {
    repo,
    outDir,
    queueFile: qf,
    total: q.total,
    cursor: q.cursor,
    remaining,
    kept,
    injectedKept,
    autoInject,
    injectDue,
    batchSize: Number(meta.batchSize) || DEFAULT_LEARNER_DRAIN_BATCH,
  };
}

function findPendingLearnerQueues(workspaceRoot) {
  const seen = new Set();
  const due = [];
  for (const outDir of learnerQueueDirs(path.resolve(workspaceRoot || SELF_REPO))) {
    const absOut = path.resolve(outDir);
    if (seen.has(absOut)) continue;
    seen.add(absOut);
    const q = learnerQueueFromDir(path.resolve(workspaceRoot || SELF_REPO), absOut);
    if (q) due.push(q);
  }
  return due;
}

function findPendingLearnerRepos(workspaceRoot) {
  return Array.from(new Set(findPendingLearnerQueues(workspaceRoot).map((q) => q.repo)));
}

async function injectLearnerQueue(repoAbs, outDir, cfg, kept) {
  writeLearnerStatus(outDir, { repo: repoAbs, outDir, injecting: true, error: null });
  const result = await runDrain({
    bin: process.execPath,
    args: [path.join(SELF_REPO, 'scripts', 'onboard-learn.js'), '--repo', repoAbs, '--in', outDir, '--inject', '--confirm'],
    cwd: repoAbs,
    timeoutMs: cfg.timeoutMs,
  });
  if (result.exitCode === 0 && !result.timedOut) {
    writeLearnerStatus(outDir, { repo: repoAbs, outDir, injecting: false, injected: true, injectedKept: Math.max(0, Number(kept) || 0), injectedAt: new Date().toISOString(), error: null });
  } else {
    writeLearnerStatus(outDir, {
      repo: repoAbs,
      outDir,
      injecting: false,
      error: `inject exited ${result.exitCode}${result.timedOut ? ' (timed out)' : ''}${result.spawnError ? `: ${result.spawnError}` : ''}`,
    });
  }
  return result;
}

function learnerChildTimeoutMs(cfg) {
  return Math.max(
    1000,
    Number(process.env.HEADLESS_DRAIN_LEARNER_TIMEOUT_MS) || DEFAULT_LEARNER_TIMEOUT_MS
  );
}

function learnerTimedOut(result) {
  if (!result) return false;
  if (result.timedOut) return true;
  if (result.exitCode === 124) return true;
  return /ETIMEDOUT|timed out|timeout/i.test(`${result.stderr || ''}\n${result.stdout || ''}`);
}

async function runOneLearner({ queue, cfg, workspaceRoot, daemonHttp, drainResults, globalLease }) {
  const repoAbs = queue.repo;
  const timeoutArg = learnerChildTimeoutMs(cfg);
  const nodeArgs = buildLearnerArgs(repoAbs, queue.outDir, timeoutArg).concat(['--batch', String(queue.batchSize || DEFAULT_LEARNER_DRAIN_BATCH)]);
  const nodeBin = process.execPath; // same Node that runs the daemon

  process.stdout.write(`[headless-drain] LEARNER starting for repo=${repoAbs} outDir=${queue.outDir}\n`);

  let drainResult;
  try {
    if (queue.remaining > 0) {
      writeLearnerStatus(queue.outDir, { repo: repoAbs, outDir: queue.outDir, error: null });
      drainResult = await runDrain({
        bin: nodeBin,
        args: nodeArgs,
        cwd: repoAbs,
        timeoutMs: timeoutArg + 1000,
      });
    } else {
      drainResult = { exitCode: 0, stdout: '', stderr: '', timedOut: false, spawnError: null };
    }
    const refreshed = learnerQueueFromDir(workspaceRoot, queue.outDir);
    if (drainResult.exitCode === 0 && !drainResult.timedOut && (queue.injectDue || (refreshed && refreshed.injectDue))) {
      const injectTarget = refreshed || queue;
      const injectResult = await injectLearnerQueue(repoAbs, queue.outDir, cfg, injectTarget.kept);
      drainResult = injectResult.exitCode === 0 && !injectResult.timedOut ? drainResult : injectResult;
    }
  } finally {
    _governor.concurrentRunning = Math.max(0, _governor.concurrentRunning - 1);
    if (globalLease && typeof globalLease.release === 'function') globalLease.release();
  }
  const effectiveResult = learnerTimedOut(drainResult)
    ? { ...drainResult, timedOut: true }
    : drainResult;
  recordDrainOutcome(effectiveResult);   // LLM-backed learner — feed the rate-limit backoff

  const summary = {
    drain: LEARNER_DRAIN_KEY,
    repo: repoAbs,
    outDir: queue.outDir,
    exitCode: drainResult.exitCode,
    timedOut: effectiveResult.timedOut,
    spawnError: drainResult.spawnError,
  };

  if (drainResult.exitCode === 0 && !drainResult.timedOut) {
    process.stdout.write(`[headless-drain] LEARNER done for repo=${repoAbs} outDir=${queue.outDir} exit=0\n`);
  } else {
    writeLearnerStatus(queue.outDir, {
      repo: repoAbs,
      outDir: queue.outDir,
      error: learnerTimedOut(drainResult) ? null : `drain exited ${drainResult.exitCode}${drainResult.timedOut ? ' (timed out)' : ''}${drainResult.spawnError ? `: ${drainResult.spawnError}` : ''}`,
      lastError: `drain exited ${drainResult.exitCode}${learnerTimedOut(drainResult) ? ' (timed out)' : ''}${drainResult.spawnError ? `: ${drainResult.spawnError}` : ''}`,
    });
    process.stdout.write(
      `[headless-drain] LEARNER FAILED repo=${repoAbs} outDir=${queue.outDir} exit=${drainResult.exitCode} timedOut=${effectiveResult.timedOut}\n`
    );
  }
  drainResults.push(summary);

  // Report progress back to the graph so the dashboard reflects drain activity.
  // Best-effort — if the daemon HTTP call fails, the drain still ran.
  _reportDrainProgress(summary, daemonHttp).catch(() => {});
}

// ---- JUDGE drain ---------------------------------------------------------------------

/**
 * Build the prompt/argv payload for one headless judge-drain invocation.
 *
 * The spawned agent drives the `self-learn` skill's edge-judge mode against the daemon over HTTP,
 * covering BOTH queue paths:
 *   - PERIODIC (node omitted): GET /judge/next?budget=N — the depth-driven cursor-walked queue.
 *   - EAGER  (node set):       GET /judge/next?node=<key>&budget=N — the node-scoped path for a
 *                              freshly-wired node pending eager judgment.
 * In both cases the agent reasons each item and POSTs /judge/verdict, bounded to the budget.
 *
 * Mirrors the historical headless-agent flag shape, but —
 * unlike the learner (which runs MCP-off and writes a JSON file) — the judge MUST reach the live
 * daemon, so it is pointed at the workspace `.mcp.json` (orchestrator-graph MCP) and the daemon URL
 * is baked into the prompt. The skill itself only uses /judge/next + /judge/verdict (it adds NO new
 * daemon behavior), so HTTP + the named skill are all it needs.
 *
 * @param {object} opts
 *   @param {number}  opts.budget    — max items this run may adjudicate (bounded; clamped 1..50).
 *   @param {string} [opts.node]     — eager node key; omit for the periodic path.
 *   @param {string} [opts.daemonUrl]— daemon base URL (default DAEMON_BASE_URL).
 *   @param {string} [opts.mcpConfig]— path to the .mcp.json granting orchestrator-graph (optional).
 *   @param {string} [opts.addDir]   — workspace dir to grant the agent read access (optional).
 *   @param {string} [opts.model]    — model id (default from HEADLESS_DRAIN_JUDGE_MODEL or 'opus').
 * @returns {string[]} argv for `claude` (NOT including the binary itself).
 */
// Build the judge-drain PROMPT (the -p text) for a periodic or eager run, clamping budget to 1..50.
// Extracted from buildJudgeArgs so the SELECTABLE BACKEND path can hand this prompt to the active
// provider's buildInvocation() (which owns the flag set) instead of this module re-assembling argv.
// Pure; returns { prompt, budget, model }.
function buildJudgePrompt(opts = {}) {
  // Default only when budget is absent/non-numeric; a provided number is CLAMPED to 1..50 (so an
  // explicit 0 floors to 1 rather than silently jumping to the default).
  const rawBudget = Number(opts.budget);
  const budget = Math.max(1, Math.min(Number.isFinite(rawBudget) ? rawBudget : DEFAULT_JUDGE_DRAIN_BUDGET, 50));
  const node = opts.node ? String(opts.node) : null;
  const daemonUrl = opts.daemonUrl || DAEMON_BASE_URL;
  const model = opts.model || process.env.HEADLESS_DRAIN_JUDGE_MODEL || 'opus';
  const workspace = opts.workspace ? String(opts.workspace) : null;
  const workspaceParam = workspace ? `&workspace=${encodeURIComponent(workspace)}` : '';

  // The endpoint the agent should pull from — encodes periodic vs eager so the prompt is unambiguous.
  const nextPath = node
    ? `/judge/next?node=${encodeURIComponent(node)}&budget=${budget}${workspaceParam}`
    : `/judge/next?budget=${budget}${workspaceParam}`;

  const prompt = [
    `Invoke the self-learn skill in edge-judge single-pass headless mode against the orchestrator daemon at ${daemonUrl}.`,
    node
      ? `EAGER path: pull this node's unjudged candidate edge-set in one slice via GET ${daemonUrl}${nextPath} (node-scoped, node=${node}).`
      : `PERIODIC path: pull the depth-driven queue via GET ${daemonUrl}${nextPath} (cursor-walked).`,
    `Reason each returned item per the skill's conservative criteria and apply your decisions with POST ${daemonUrl}/judge/verdict.`,
    `Adjudicate AT MOST ${budget} items this run, then stop — do NOT loop, fan out, or re-walk the queue. If /judge/next returns idle:true, stop immediately.`,
  ].join(' ');

  return { prompt, budget, model };
}

function buildJudgeArgs(opts = {}) {
  const { prompt, model } = buildJudgePrompt(opts);
  const args = ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig, '--strict-mcp-config');
  if (opts.addDir) args.push('--add-dir', opts.addDir);
  return args;
}

// ---- SELECTABLE BACKEND resolution for the judge drain -------------------------------
// Resolve the configured backend (lib/llm-backend.getActiveBackend) and decide how the judge drain
// should run against it. The judge is the ONLY agentic drain (learner/label are deterministic Node
// scripts), so it is the only path routed through the backend. Returns one of:
//   { skip: 'no_backend' }                    — HARD-BLOCK: the active provider is not usable on this
//                                                host (agentic-cli not available OR not authed; OR an
//                                                api provider with no API key). The drain no-ops cleanly
//                                                (clean pause + signal), no crash.
//   { provider, providerId, kind:'api', apiArgs } — an IN-PROCESS api judge call: the drain calls
//                                                provider.runJudgeLoop(apiArgs) (Node https/http, NO
//                                                child process) instead of spawning. apiArgs carries
//                                                { budget, node, model, daemonUrl } per call.
//   { provider, providerId, invocation }       — a ready, spawnable agentic-cli invocation: invocation
//                                                is { bin, args, env } from provider.buildInvocation.
// `overlay` is the workspace overlay; `deps.backendLib` is injectable for tests (defaults to the real
// lib/llm-backend). `promptOpts` is forwarded to buildJudgePrompt ({ budget, node, mcpConfig, addDir }).
function resolveJudgeBackend(overlay, promptOpts = {}, deps = {}) {
  const backendLib = deps.backendLib || require('./llm-backend');
  const active = backendLib.getActiveBackend(overlay);
  const provider = active && active.provider;
  if (!provider) return { skip: 'no_backend' }; // registry empty/misconfigured — never happens, but safe.

  // API-kind backend: drive the judge IN-PROCESS via provider.runJudgeLoop (Node https/http, no child).
  // HARD-BLOCK first if unauthed (no API key) — same clean pause as an unusable CLI, so an api backend
  // with no key no-ops rather than failing the in-process call. The drain runner invokes runJudgeLoop;
  // resolveJudgeBackend stays pure (it builds NO invocation and makes NO call here).
  if (provider.kind === 'api') {
    const apiAuthed = typeof provider.isAuthed === 'function' ? safeBool(provider.isAuthed.bind(provider)) : false;
    if (!apiAuthed) return { skip: 'no_backend' };
    return { provider, providerId: active.providerId, kind: 'api', model: active.model };
  }

  // agentic-cli backend: HARD-BLOCK if the resolved binary is not usable or not authenticated. A
  // missing/unauthed CLI must pause the judge drain (clean signal), never spawn-and-fail in a loop.
  const available = typeof provider.isAvailable === 'function' ? safeBool(provider.isAvailable.bind(provider)) : false;
  const authed = typeof provider.isAuthed === 'function' ? safeBool(provider.isAuthed.bind(provider)) : false;
  if (!available || !authed) return { skip: 'no_backend' };

  // Build the prompt, then let the PROVIDER own the flag set (mirrors the historical judge argv).
  const { prompt, model } = buildJudgePrompt({ ...promptOpts, model: promptOpts.model || active.model });
  const invocation = provider.buildInvocation({
    prompt,
    model,
    mcpConfig: promptOpts.mcpConfig || undefined,
    addDir: promptOpts.addDir || undefined,
  });
  return { provider, providerId: active.providerId, invocation };
}

// Small guard so a provider probe that throws degrades to false rather than crashing the drain pass.
function safeBool(fn) { try { return !!fn(); } catch { return false; } }

/**
 * Discover whether the judge queue has due work, reading the daemon's overlay directly (the same
 * "read the local state file" approach findPendingLearnerRepos uses for the learner queue — no HTTP
 * round-trip needed for due-detection; the spawned agent itself talks HTTP).
 *
 * Returns { periodic: boolean, eagerNodes: string[], depth: number }:
 *   - periodic   — true iff the cursor-walked queue has any depth (judge.buildQueue length > 0).
 *   - eagerNodes — node keys pending EAGER judgment (judge.eagerJudgeNodes), node-scoped path.
 *   - depth      — periodic queue depth (for logging/telemetry).
 *
 * Dependencies are injected for testability (default to the real overlay/judge libs); any failure
 * is swallowed and reported as "no due work" so a missing overlay never spawns or throws.
 *
 * @param {string} workspaceRoot
 * @param {object} [deps] — { overlayLoad(workspace)=>overlay, judgeLib={judgeQueueDepth,buildQueue,eagerJudgeNodes} }
 */
function findDueJudgeWork(workspaceRoot, deps = {}) {
  const none = { periodic: false, eagerNodes: [], depth: 0 };
  try {
    const overlayLoad = deps.overlayLoad || require('./overlay').load;
    const judgeLib = deps.judgeLib || require('./judge');
    const overlay = overlayLoad(workspaceRoot);
    if (!overlay) return none;
    const eagerNodes = judgeLib.eagerJudgeNodes(overlay) || [];
    const depth = typeof judgeLib.judgeQueueDepth === 'function'
      ? (Number(judgeLib.judgeQueueDepth(overlay)) || 0)
      : ((judgeLib.buildQueue(overlay) || []).length);
    return { periodic: depth > 0, eagerNodes, depth };
  } catch {
    return none;
  }
}

/**
 * Claim the daemon-owned judge work this drain tick will execute.
 *
 * Eager node marks remain the same review queue substrate, but they are no longer returned from the
 * foreground /next-action loop. This helper moves the old loop-side lease into the daemon-internal
 * drain runner: lease eager nodes before spawning a judge so another daemon/drain pass skips them,
 * then compute periodic depth after those leases so the periodic cursor does not duplicate the same
 * incident edges. The /judge/next?node route clears the lease when the node-scoped handoff drains.
 */
function claimDueJudgeWork(workspaceRoot, deps = {}, opts = {}) {
  const none = { periodic: false, eagerNodes: [], depth: 0 };
  try {
    const overlayStore = deps.overlayStore || require('./overlay');
    const usingInjectedLoad = typeof deps.overlayLoad === 'function';
    const overlayLoad = deps.overlayLoad || overlayStore.load;
    const overlaySave = deps.overlaySave || (!usingInjectedLoad ? overlayStore.save : null);
    const judgeLib = deps.judgeLib || require('./judge');
    const overlay = deps.overlay || overlayLoad(workspaceRoot);
    if (!overlay) return none;

    const beforeMarks = new Set(Object.keys(overlay.eagerJudge || {}));
    const pendingAll = judgeLib.eagerJudgeNodes(overlay) || [];
    const maxEager = opts.maxEagerNodes == null
      ? pendingAll.length
      : Math.max(0, Math.min(pendingAll.length, Number(opts.maxEagerNodes) || 0));
    const pending = pendingAll.slice(0, maxEager);
    let dirty = false;
    for (const key of beforeMarks) {
      if (!overlay.eagerJudge || !(key in overlay.eagerJudge)) dirty = true;
    }

    const leaseOwner = opts.leaseOwner || `headless-drain:${process.pid}`;
    const leaseTtlMs = opts.leaseTtlMs || 60000;
    const acquire = deps.acquireEagerJudgeLease || overlayStore.acquireEagerJudgeLease;
    const eagerNodes = [];
    for (const nodeKey of pending) {
      if (typeof acquire === 'function') {
        if (!acquire(overlay, nodeKey, leaseOwner, leaseTtlMs)) continue;
        dirty = true;
      }
      eagerNodes.push(nodeKey);
    }

    const depth = typeof judgeLib.judgeQueueDepth === 'function'
      ? (Number(judgeLib.judgeQueueDepth(overlay)) || 0)
      : ((judgeLib.buildQueue(overlay) || []).length);

    if (dirty && typeof overlaySave === 'function') overlaySave(workspaceRoot, overlay);
    return { periodic: depth > 0, eagerNodes, depth };
  } catch {
    return none;
  }
}

// ---- LABEL drain ---------------------------------------------------------------------

/**
 * Build the argv for the label drain invocation.
 * Mirrors `node scripts/gate-label.js --workspace <abs> --port <n>` — but we call `node` directly
 * (via process.execPath in the caller) so the runner is not dependent on the system having `node`
 * on PATH, the SAME way buildLearnerArgs does. gate-label.js is a DETERMINISTIC Node script
 * (gate-journal.jsonl → .graph/gate-labeled.jsonl), NOT an agentic CLI run.
 */
function buildLabelArgs(workspaceAbs, port) {
  const script = path.join(SELF_REPO, 'scripts', 'gate-label.js');
  const p = String(port || process.env.ORCH_PORT || 8787);
  return [script, '--workspace', workspaceAbs, '--port', p];
}

/**
 * Discover whether the gate-label queue has due work by reading the local journal/labeled JSONL
 * files directly — the SAME "read the local state file" approach findPendingLearnerRepos uses for
 * the learner queue (no HTTP round-trip for due-detection; the spawned script itself talks HTTP).
 *
 * "Due" means: gate-journal.jsonl has at least one row that (a) carries a task_key and (b) is not
 * already present in gate-labeled.jsonl (dedup by the SAME rowKey hash gate-label.js uses). This is
 * deliberately coarse — it does NOT pre-check terminal status (which would require the daemon).
 * gate-label.js is idempotent and fail-soft: it simply skips rows whose task is not yet terminal,
 * so a due:true that yields zero newly-labeled rows is a cheap, harmless no-op spawn, never a bug.
 *
 * Dependencies are injected for testability (default to the real scripts/gate-label helpers); any
 * failure is swallowed and reported as "no due work" so a missing/corrupt journal never spawns.
 *
 * @param {string} workspaceRoot
 * @param {object} [deps] — { readJsonl(file)=>rows[], rowKey(row)=>string,
 *                            journalPath(ws)=>abs, labeledPath(ws)=>abs } (gate-label.js exports)
 * @returns {{ due: boolean, pending: number }}
 */
function findDueLabelWork(workspaceRoot, deps = {}) {
  const none = { due: false, pending: 0 };
  try {
    const gl = require('../scripts/gate-label');
    const readJsonl = deps.readJsonl || gl.readJsonl;
    const rowKey = deps.rowKey || gl.rowKey;
    const journalPath = deps.journalPath || gl.journalPath;
    const labeledPath = deps.labeledPath || gl.labeledPath;

    const journalRows = readJsonl(journalPath(workspaceRoot)) || [];
    const labeledRows = readJsonl(labeledPath(workspaceRoot)) || [];
    const labeledKeys = new Set(labeledRows.map((r) => r._key).filter(Boolean));

    let pending = 0;
    for (const row of journalRows) {
      if (!row || !row.task_key) continue;          // unlabelable without a task_key
      if (labeledKeys.has(rowKey(row))) continue;    // already labeled (dedup)
      pending++;
    }
    return { due: pending > 0, pending };
  } catch {
    return none;
  }
}

function labelDrainWorkspaceKey(workspaceRoot) {
  return path.resolve(workspaceRoot || SELF_REPO);
}

function scheduleDetachedLabelDrain({ labelDue, cfg, workspaceRoot, daemonHttp, globalLease }) {
  const workspaceKey = labelDrainWorkspaceKey(workspaceRoot);
  _activeDetachedLabels.add(workspaceKey);

  const nodeBin = process.execPath; // same Node that runs the daemon
  const labelArgs = buildLabelArgs(workspaceRoot, Number(process.env.ORCH_PORT) || 8787);

  process.stdout.write(`[headless-drain] LABEL starting pending=${labelDue.pending}\n`);

  runDrain({
    bin: nodeBin,
    args: labelArgs,
    cwd: workspaceRoot,
    timeoutMs: cfg.timeoutMs,
  }).then((drainResult) => {
    const summary = {
      drain: LABEL_DRAIN_KEY,
      pending: labelDue.pending,
      exitCode: drainResult.exitCode,
      timedOut: drainResult.timedOut,
      spawnError: drainResult.spawnError,
    };

    if (drainResult.exitCode === 0 && !drainResult.timedOut) {
      // Commit ONLY on real progress. gate-label.js idempotently DEFERS rows whose task isn't terminal
      // yet, but findDueLabelWork counts those deferred rows as `pending` (it can't see terminal-ness),
      // so it reports due:true forever. Committing the (large) .graph on every such no-op run was the
      // event-loop saturation: repeated synchronous git commits with nothing newly labeled — and the
      // commit itself re-triggered the drain wake, hot-looping back-to-back. Recompute pending; commit
      // (and log) only when it actually dropped. A no-op just releases its slot. (Deferred rows still
      // re-spawn a cheap labeler each tick; making findDueLabelWork terminal-aware is the deeper fix.)
      const pendingAfter = findDueLabelWork(workspaceRoot).pending;
      if (pendingAfter < labelDue.pending) {
        summary.labeled = labelDue.pending - pendingAfter;
        summary.gitCommit = commitGraphSnapshot(workspaceRoot, 'headless label drain');
        process.stdout.write(`[headless-drain] LABEL done labeled=${summary.labeled} pending=${pendingAfter} exit=0\n`);
      } else {
        summary.labeled = 0;
        process.stdout.write(`[headless-drain] LABEL no-op (${pendingAfter} deferred non-terminal rows) — skipping .graph commit\n`);
      }
    } else {
      process.stdout.write(
        `[headless-drain] LABEL FAILED pending=${labelDue.pending} exit=${drainResult.exitCode} timedOut=${drainResult.timedOut}\n`
      );
    }

    _reportDrainProgress(summary, daemonHttp).catch(() => {});
  }).catch((err) => {
    process.stdout.write(`[headless-drain] LABEL FAILED pending=${labelDue.pending} error=${err && err.message ? err.message : err}\n`);
  }).finally(() => {
    _governor.concurrentRunning = Math.max(0, _governor.concurrentRunning - 1);
    if (globalLease && typeof globalLease.release === 'function') globalLease.release();
    _activeDetachedLabels.delete(workspaceKey);
  });
}

/**
 * Check governor budget/concurrency limits and run any due drains.
 *
 * This is the entry point called from the daemon's setInterval trigger.
 *
 * @param {object} state — daemon state (used for workspace root path).
 *                         May be null/undefined (safe — treated as { workspace: SELF_REPO }).
 * @param {object} [daemonHttp] — optional HTTP module for posting progress back to daemon
 *                                (injected for testability; defaults to require('http')).
 * @param {object} [options] — optional injection seam for tests:
 *                             { judgeDeps: { overlayLoad, judgeLib } } forwarded to findDueJudgeWork
 *                             so judge due-detection can be mocked without a live overlay;
 *                             { labelDeps: { readJsonl, rowKey, journalPath, labeledPath } }
 *                             forwarded to findDueLabelWork so label due-detection can be mocked
 *                             without real journal files.
 * @returns {Promise<{ ran: number, skipped: string, drains: Array }>} summary of what happened.
 *
 * ASYNC: uses non-blocking child processes so the daemon's event loop stays free during every drain
 * child. Learner/judge await their slot-refill loops inside this pump; label is scheduled as a
 * detached child and releases its slot on completion.
 */
async function runDueDrains(state, daemonHttp, options = {}) {
  // ---- safety gate -----------------------------------------------------------------
  if (!isHeadlessEnabled()) {
    return { ran: 0, skipped: 'flag_off', drains: [] };
  }

  // ---- rate-limit/overload backoff: retreat under throttling instead of firing into it -------
  if (Date.now() < _governor.backoffUntil) {
    return { ran: 0, skipped: 'backoff', drains: [] };
  }

  const cfg = effectiveConfig();

  // ---- governor budget/concurrency check ------------------------------------------
  if (_governor.iterationsUsed >= cfg.maxIterations) {
    return { ran: 0, skipped: 'iterations_exhausted', drains: [] };
  }
  if (_governor.tokensUsed >= cfg.tokenBudget) {
    return { ran: 0, skipped: 'token_budget_exhausted', drains: [] };
  }
  if (_governor.concurrentRunning >= cfg.maxConcurrency) {
    return { ran: 0, skipped: 'concurrency_cap', drains: [] };
  }

  // Load legacy install env for agentic CLI credentials. Hosted API providers read daemon-global
  // backend.env from the runtime data dir in lib/llm-backend.js, so they are not workspace-local.
  loadEnvForClaude(SELF_REPO);

  const workspaceRoot = (state && state.workspace) || SELF_REPO;
  const drainResults = [];
  let capacitySkipReason = null;

  // ---- LEARNER drain ---------------------------------------------------------------
  const pendingQueues = findPendingLearnerQueues(workspaceRoot);
  if (pendingQueues.length) {
    const learnerMaxPerTick = process.env.HEADLESS_DRAIN_LEARNER_MAX_PER_TICK
      ? (Number(process.env.HEADLESS_DRAIN_LEARNER_MAX_PER_TICK) || cfg.maxConcurrency)
      : Math.min(1, cfg.maxConcurrency);
    const totalLearnerBatches = pendingQueues.reduce((sum, q) => {
      const batchSize = Math.max(1, Number(q.batchSize) || DEFAULT_LEARNER_DRAIN_BATCH);
      return sum + (q.remaining > 0 ? Math.ceil(q.remaining / batchSize) : 0) + (q.injectDue ? 1 : 0);
    }, 0);
    let learnerSpawnsThisTick = 0;
    let learnerIndex = 0;
    const activeLearnerRuns = new Set();

    const availableLearnerSlots = () => Math.max(0, Math.min(
      learnerMaxPerTick - learnerSpawnsThisTick,
      totalLearnerBatches - learnerSpawnsThisTick,
      cfg.maxConcurrency - _governor.concurrentRunning,
      cfg.maxIterations - _governor.iterationsUsed
    ));

    const enqueueLearner = () => {
      if (Date.now() < _governor.backoffUntil) return false;
      if (availableLearnerSlots() <= 0) return false;
      const queue = pendingQueues[learnerIndex % pendingQueues.length];
      learnerIndex++;
      const lease = acquireGlobalDrainSlot(cfg, 'learner');
      if (!lease.ok) {
        capacitySkipReason = lease.reason;
        return false;
      }
      _governor.concurrentRunning++;
      _governor.iterationsUsed++;
      let run;
      run = runOneLearner({ queue, cfg, workspaceRoot, daemonHttp, drainResults, globalLease: lease })
        .finally(() => { activeLearnerRuns.delete(run); });
      activeLearnerRuns.add(run);
      learnerSpawnsThisTick++;
      return true;
    };
    const refillLearnerSlots = () => {
      let started = false;
      while (enqueueLearner()) started = true;
      return started;
    };

    refillLearnerSlots();
    while (activeLearnerRuns.size) {
      await Promise.race(activeLearnerRuns);
      refillLearnerSlots();
    }
    const learnerResults = drainResults.filter((d) => d.drain === LEARNER_DRAIN_KEY);
    const successfulRepos = Array.from(new Set(learnerResults
      .filter((d) => d.exitCode === 0 && !d.timedOut)
      .map((d) => d.repo)));
    for (const repoAbs of successfulRepos) {
      const gitCommit = commitGraphSnapshot(repoAbs, 'headless learner drain');
      for (const d of learnerResults) if (d.repo === repoAbs) d.gitCommit = gitCommit;
    }
  }

  // ---- JUDGE drain -----------------------------------------------------------------
  // Drives the self-learn skill edge-judge mode via the SELECTABLE BACKEND (lib/llm-backend) against the
  // daemon, covering BOTH the eager (node-scoped) and periodic (cursor-walked) /judge/next paths.
  // Rides the SAME governor as the learner above — no second spawn/resolve path. Eager nodes are
  // judged first (freshly-wired, latency-sensitive), then ONE periodic batch fills any remaining slot.
  //
  // The judge is the ONLY agentic drain, so it is the only path routed through the configured
  // provider: getActiveBackend(overlay).buildInvocation(...) drives the spawn {bin,args,env}, not a
  // hardcoded `claude` binary. HARD-BLOCK: if there is no valid backend (configured provider not
  // available/authed, or none set and Claude unavailable, or an api provider with no key) the judge
  // drain no-ops with skipped:'no_backend'. API-kind backend: the judge runs IN-PROCESS via
  // provider.runJudgeLoop (Node https/http, NO child process) instead of spawning.
  let judgeSkipReason = null; // surfaced as runDueDrains' skipped reason when judge is the only due work
  const dueProbe = findDueJudgeWork(workspaceRoot, options.judgeDeps);
  if (dueProbe.eagerNodes.length || dueProbe.periodic) {
    const mcpConfig = _resolveMcpConfig(workspaceRoot);
    const judgeBudget = Number(process.env.HEADLESS_DRAIN_JUDGE_BUDGET) || DEFAULT_JUDGE_DRAIN_BUDGET;

    // Resolve the active backend ONCE for this tick's judge work. The overlay loader is the SAME one
    // findDueJudgeWork uses (injectable via options.judgeDeps.overlayLoad) so tests drive both off one
    // mocked overlay. A skip (no_backend) means we run NOTHING — the guard is the deliberate clean
    // pause, not a crash. A ready api backend runs IN-PROCESS (no spawn) inside _runOneJudge.
    const overlay = _loadOverlayForBackend(workspaceRoot, options.judgeDeps);
    const resolved = resolveJudgeBackend(overlay, { mcpConfig, addDir: workspaceRoot }, options.backendDeps);
    if (resolved.skip) {
      judgeSkipReason = resolved.skip;
      process.stdout.write(`[headless-drain] JUDGE skipped (${resolved.skip}) — no spawn this tick\n`);
    } else {
      const provider = resolved.provider;
      // Optional per-pump cap on judge spawns (distinct from maxIterations, which is per daemon
      // boot). By default the pool keeps refilling slots until the currently-known queue is drained
      // or backoff trips. Set HEADLESS_DRAIN_MAX_PER_TICK to bound total starts per pump.
      const maxPerTick = process.env.HEADLESS_DRAIN_MAX_PER_TICK
        ? (Number(process.env.HEADLESS_DRAIN_MAX_PER_TICK) || cfg.maxConcurrency)
        : Number.POSITIVE_INFINITY;
      const localJudgeSlots = Math.max(0, Math.min(
        maxPerTick,
        cfg.maxConcurrency - _governor.concurrentRunning,
        cfg.maxIterations - _governor.iterationsUsed
      ));
      const due = claimDueJudgeWork(workspaceRoot, options.judgeDeps, {
        leaseOwner: `headless-drain:${process.pid}`,
        leaseTtlMs: Math.max(60000, cfg.timeoutMs || 0),
        maxEagerNodes: localJudgeSlots,
      });
      if (!due.eagerNodes.length && !due.periodic) {
        judgeSkipReason = 'no_due_drains';
      } else {
        const judgeResultStart = drainResults.length;
        let judgeSpawnsThisTick = 0;
        const activeJudgeRuns = new Set();
        let eagerIndex = 0;
        let periodicBatches = due.periodic
          ? Math.max(1, Math.ceil((Number(due.depth) || 1) / judgeBudget))
          : 0;

        const availableJudgeSlots = () => Math.max(0, Math.min(
          maxPerTick - judgeSpawnsThisTick,
          cfg.maxConcurrency - _governor.concurrentRunning,
          cfg.maxIterations - _governor.iterationsUsed
        ));

        const peekNextJudge = () => {
          if (eagerIndex < due.eagerNodes.length) return { node: due.eagerNodes[eagerIndex], mode: 'eager' };
          if (periodicBatches > 0) return { node: null, mode: 'periodic' };
          return null;
        };
        const consumeNextJudge = () => {
          if (eagerIndex < due.eagerNodes.length) eagerIndex++;
          else if (periodicBatches > 0) periodicBatches--;
        };
        const enqueueJudge = () => {
          if (Date.now() < _governor.backoffUntil) return false;
          if (availableJudgeSlots() <= 0) return false;
          const next = peekNextJudge();
          if (!next) return false;
          const lease = acquireGlobalDrainSlot(cfg, 'judge');
          if (!lease.ok) {
            judgeSkipReason = lease.reason;
            return false;
          }
          consumeNextJudge();
          let run;
          run = _runOneJudge({ ...next, cfg, provider, overlay, judgeBudget, mcpConfig, workspaceRoot, daemonHttp, drainResults, globalLease: lease })
            .finally(() => { activeJudgeRuns.delete(run); });
          activeJudgeRuns.add(run);
          judgeSpawnsThisTick++;
          return true;
        };
        const refillJudgeSlots = () => {
          let started = false;
          while (enqueueJudge()) started = true;
          return started;
        };

        // EAGER: one node-scoped run per pending node, bounded by the governor AND the per-tick cap —
        // the cap bounds the EAGER burst (1 spawn per freshly-wired node); the excess rides later ticks.
        // PERIODIC: after eager nodes, schedule cursor-walked batches. The route advances judgeCursor
        // on each /judge/next request, so parallel children receive separate slices. Slot-refill keeps
        // up to maxConcurrency active: when one run exits, another starts immediately if current work
        // remains and no throttle/backoff was recorded by the completed run.
        refillJudgeSlots();
        while (activeJudgeRuns.size) {
          await Promise.race(activeJudgeRuns);
          refillJudgeSlots();
        }
        const judgeResults = drainResults.slice(judgeResultStart).filter((d) => d.drain === JUDGE_DRAIN_KEY);
        if (judgeResults.some((d) => d.exitCode === 0 && !d.timedOut)) {
          const gitCommit = commitGraphSnapshot(workspaceRoot, 'headless judge drain');
          for (const d of judgeResults) d.gitCommit = gitCommit;
        }
      }
    }
  }

  // ---- LABEL drain -----------------------------------------------------------------
  // Runs the DETERMINISTIC gate-labeler (node scripts/gate-label.js) headless under the SAME
  // governor as the learner/judge — no second spawn/resolve path. It is scheduled as a detached
  // async child: the daemon pump returns after reserving the governor slot, and completion releases
  // that slot + snapshots .graph. One bounded run per pass is sufficient — gate-label.js drains the
  // entire gradable backlog in a single idempotent invocation.
  const labelDue = findDueLabelWork(workspaceRoot, options.labelDeps);
  if (labelDue.due
      && _governor.iterationsUsed < cfg.maxIterations
      && _governor.concurrentRunning < cfg.maxConcurrency) {
    const workspaceKey = labelDrainWorkspaceKey(workspaceRoot);
    if (_activeDetachedLabels.has(workspaceKey)) {
      capacitySkipReason = capacitySkipReason || 'label_in_progress';
    } else {
      const lease = acquireGlobalDrainSlot(cfg, 'label');
      if (!lease.ok) {
        capacitySkipReason = capacitySkipReason || lease.reason;
      } else {
        _governor.concurrentRunning++;
        _governor.iterationsUsed++;

        scheduleDetachedLabelDrain({ labelDue, cfg, workspaceRoot, daemonHttp, globalLease: lease });
        const summary = {
          drain: LABEL_DRAIN_KEY,
          pending: labelDue.pending,
          detached: true,
          scheduled: true,
        };
        drainResults.push(summary);
      }
    }
  }

  // Skip reason precedence when nothing ran: a judge HARD-BLOCK / api-skip is more informative than
  // the generic 'no_due_drains' (it tells the dashboard WHY a due judge produced no spawn). If any
  // drain ran, skipped is null regardless (the judge skip is non-fatal, other drains still count).
  const skipped = drainResults.length ? null : (judgeSkipReason || capacitySkipReason || 'no_due_drains');
  return { ran: drainResults.length, skipped, drains: drainResults };
}

/**
 * Run ONE judge-drain invocation through the governor and record its summary. Two backend kinds share
 * this single accounting path (the whole point: no duplicate path):
 *   - agentic-cli: `provider.buildInvocation({prompt,model,mcpConfig,addDir})` returns the spawnable
 *     { bin, args, env } (provider-owned argv); runDrain SPAWNS a child.
 *   - api: `provider.runJudgeLoop({daemonUrl,budget,node,model})` walks the /judge/next →
 *     /judge/verdict loop IN-PROCESS (Node https/http, NO child process) and resolves the SAME
 *     drain-result shape, so recordDrainOutcome + the summary consume it identically.
 * The provider is resolved+validated ONCE by the caller (resolveJudgeBackend) and passed in, so every
 * per-node/periodic run shares the same active backend.
 *
 * Mutates _governor + pushes onto drainResults.
 *
 * ASYNC: awaits the run (the deadlock fix) so the daemon event loop stays free. For the spawn path the
 * child calls BACK into this daemon over HTTP (GET /judge/next + POST /judge/verdict), so blocking here
 * is precisely what would deadlock. The in-process api path ALSO calls those endpoints over HTTP from
 * within this same daemon, so it must likewise stay async (await, never block). Callers await this.
 * @returns {Promise<void>}
 */
/**
 * Run ONE judge round against the resolved provider and resolve a DRAIN-RESULT-shaped object
 * ({ exitCode, stdout, stderr, timedOut, spawnError }) — the SHARED backend-kind branch both the
 * background async drain (_runOneJudge) and the synchronous drain (runJudgeDrainSync) use, so there
 * is exactly ONE place that knows how each kind is driven (no second judge / second prompt):
 *
 *   - kind 'api': IN-PROCESS via provider.runJudgeLoop({daemonUrl,budget,node,model,key}) (Node
 *     https/http, NO child process). A throwing adapter degrades to a clean exitCode:1 result so the
 *     pass never crashes on a misbehaving provider.
 *   - kind 'agentic-cli' (claude / codex / cursor — GENERIC, never hardcoded): build the node-scoped
 *     invocation via provider.buildInvocation({prompt,model,mcpConfig,addDir}) — the SAME path the
 *     background cli drain uses — then SPAWN it through runDrain, which enforces the per-call
 *     timeoutMs + child.kill('SIGKILL') (the bound against the old 9.5h-hang class). The spawned CLI
 *     judge talks to the daemon over HTTP itself (it adds NO new daemon behavior), so its stdout
 *     carries the same applied-counts the api path emits.
 *
 * Pure w.r.t. the governor (it neither reserves nor releases a slot); callers own accounting.
 * @returns {Promise<{ exitCode:number|null, stdout:string, stderr:string, timedOut:boolean, spawnError:(string|null) }>}
 */
async function _runJudgeRound({ provider, node, prompt, model, budget, key, mcpConfig, workspaceRoot, timeoutMs }) {
  if (provider.kind === 'api') {
    // IN-PROCESS api judge: no spawn, no console window. runJudgeLoop drives the daemon's judge loop
    // over HTTP and resolves the drain-result shape. A throwing provider degrades to a clean failure
    // result (exitCode 1) so the drain pass never crashes on a misbehaving adapter.
    try {
      return await provider.runJudgeLoop({
        daemonUrl: DAEMON_BASE_URL,
        budget,
        node: node || undefined,
        model,
        key,
      });
    } catch (e) {
      return { exitCode: 1, stdout: '', stderr: `runJudgeLoop threw: ${e && e.message ? e.message : e}`, timedOut: false, spawnError: null };
    }
  }
  // agentic-cli (claude / codex / cursor): let the PROVIDER own the flag set, then SPAWN the child.
  // GENERIC across providers — the invocation is whatever the configured provider's buildInvocation
  // returns, never a hardcoded `claude` argv. runDrain enforces timeoutMs + SIGKILL (the hang bound);
  // a synchronous buildInvocation throw degrades to a clean exitCode:1 result (no crash, clean skip).
  let invocation;
  try {
    invocation = provider.buildInvocation({
      prompt,
      model,
      mcpConfig: mcpConfig || undefined,
      addDir: workspaceRoot,
    });
  } catch (e) {
    return { exitCode: 1, stdout: '', stderr: `buildInvocation threw: ${e && e.message ? e.message : e}`, timedOut: false, spawnError: null };
  }
  const { bin, args, env } = invocation;
  const drainEnv = env ? { ...process.env, ...env } : undefined;
  return runDrain({ bin, args, env: drainEnv, cwd: workspaceRoot, timeoutMs });
}

async function _runOneJudge({ node, mode, cfg, provider, overlay, mcpConfig, workspaceRoot, judgeBudget, daemonHttp, drainResults, globalLease }) {
  _governor.concurrentRunning++;
  _governor.iterationsUsed++;

  // Build the per-call prompt opts (node-scoped for eager, cursor-walked for periodic). buildJudgePrompt
  // clamps the budget identically for both kinds; model defaults to the dashboard-selected backend model.
  const active = (overlay && overlay.config && overlay.config.backend) || {};
  const { prompt, model, budget } = buildJudgePrompt({
    budget: judgeBudget,
    node: node || undefined,
    model: active.model,
    workspace: workspaceRoot,
  });

  process.stdout.write(`[headless-drain] JUDGE starting mode=${mode}${node ? ` node=${node}` : ''} provider=${provider.id} kind=${provider.kind}\n`);

  let drainResult;
  try {
    // Shared backend-kind branch: api ⇒ in-process runJudgeLoop; agentic-cli ⇒ provider invocation
    // spawned through runDrain (bounded by cfg.timeoutMs + SIGKILL). One path, both kinds.
    drainResult = await _runJudgeRound({
      provider,
      node,
      prompt,
      model,
      budget,
      key: active.key,
      mcpConfig,
      workspaceRoot,
      timeoutMs: cfg.timeoutMs,
    });
  } finally {
    _governor.concurrentRunning = Math.max(0, _governor.concurrentRunning - 1);
    if (globalLease && typeof globalLease.release === 'function') globalLease.release();
  }
  recordDrainOutcome(drainResult);   // both kinds are LLM-backed — feed the rate-limit backoff

  const summary = {
    drain: JUDGE_DRAIN_KEY,
    mode,
    node: node || null,
    exitCode: drainResult.exitCode,
    timedOut: drainResult.timedOut,
    spawnError: drainResult.spawnError,
  };
  drainResults.push(summary);

  if (drainResult.exitCode === 0 && !drainResult.timedOut) {
    process.stdout.write(`[headless-drain] JUDGE done mode=${mode}${node ? ` node=${node}` : ''} exit=0\n`);
  } else {
    process.stdout.write(
      `[headless-drain] JUDGE FAILED mode=${mode}${node ? ` node=${node}` : ''} exit=${drainResult.exitCode} timedOut=${drainResult.timedOut}\n`
    );
  }

  _reportDrainProgress(summary, daemonHttp).catch(() => {});
}

// ---- SYNCHRONOUS node-scoped judge drain (P1) ----------------------------------------
// A bounded, blocking drain of ONE node's unjudged autowire candidate edge-set, reusing the EXACT
// in-process judge the async drain uses (resolveJudgeBackend → provider.runJudgeLoop, the kind:'api'
// "Node http, no child" path) — zero new prompt text, zero second judge implementation. Unlike
// runDueDrains (async background pump with a hang history), this resolves to idle (or the budget) in
// a single awaited call so a caller (HTTP route / CLI) gets a synchronous { judged, kept, pruned,
// idle } result. It does NOT touch _governor or the background-drain paths.

const DEFAULT_SYNC_JUDGE_ROUNDS = 50; // hard ceiling on loop iterations (defense-in-depth vs. a
                                      // never-idle queue); each round adjudicates ≤ budget items.

// Count this node's still-unjudged autowire candidate edges by reading the overlay directly — the
// SAME unverifiedEdgesForNode the eager path uses. Injectable judgeLib/overlayLoad mirror
// findDueJudgeWork so a test drives idle-detection off one synthetic overlay with no live daemon.
function _unjudgedEdgeCountForNode(workspaceRoot, node, deps = {}) {
  try {
    const overlayLoad = deps.overlayLoad || require('./overlay').load;
    const judgeLib = deps.judgeLib || require('./judge');
    const overlay = overlayLoad(workspaceRoot);
    if (!overlay) return 0;
    return (judgeLib.unverifiedEdgesForNode(overlay, node) || []).length;
  } catch {
    return 0;
  }
}

// Parse the {kept,pruned,...} applied-counts runJudgeLoop already embeds in its stdout
// ("applied={...}") so the sync drain can report keep/prune totals WITHOUT a second verdict path.
// Best-effort: any shape mismatch yields zeros, never throws.
function _parseAppliedCounts(stdout) {
  const out = { kept: 0, pruned: 0 };
  try {
    const m = String(stdout || '').match(/applied=(\{[\s\S]*?\})/);
    if (!m) return out;
    const applied = JSON.parse(m[1]);
    out.kept = Number(applied.kept) || 0;
    out.pruned = Number(applied.pruned) || 0;
  } catch { /* leave zeros */ }
  return out;
}

// Wrap a promise in the SAME per-call wall-clock timeout the existing drain applies (cfg.timeoutMs),
// so the sync drain cannot reintroduce the hang class: a runJudgeLoop that never resolves loses to
// the timer and surfaces as a timed-out, throttle-free drain-result (exitCode 1) we stop on.
function _withCallTimeout(promise, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const t = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve({ exitCode: 1, stdout: '', stderr: 'sync judge drain: per-call timeout', timedOut: true, spawnError: null });
    }, timeoutMs);
    Promise.resolve(promise).then(
      (v) => { if (!settled) { settled = true; clearTimeout(t); resolve(v); } },
      (e) => { if (!settled) { settled = true; clearTimeout(t); resolve({ exitCode: 1, stdout: '', stderr: `sync judge drain: ${e && e.message ? e.message : e}`, timedOut: false, spawnError: null }); } }
    );
  });
}

/**
 * Drive a node-scoped judge drain SYNCHRONOUSLY (one awaited call) to idle or budget, REUSING the
 * in-process judge (resolveJudgeBackend → runJudgeLoop). This is the shared core both the HTTP route
 * and the CLI call — zero new prompt text (the prompt is buildJudgePrompt, reached through the api
 * provider's runJudgeLoop), zero second judge implementation.
 *
 * Bounding (so the async drain's hang class cannot return):
 *   - budget is clamped 1..50 (same as buildJudgePrompt).
 *   - EACH runJudgeLoop call is wrapped in cfg.timeoutMs (the SAME per-call timeout runDueDrains uses).
 *   - the loop is additionally capped at maxRounds iterations.
 *
 * Idle/keep/prune accounting is read from the overlay edge-state delta (unverifiedEdgesForNode) plus
 * the applied-counts runJudgeLoop already emits — no new daemon behavior, same verdict path.
 *
 * @param {object} opts
 *   @param {string}  opts.workspaceRoot — workspace whose overlay/daemon to drive (required).
 *   @param {string}  opts.node          — node key to drain (the /judge/next?node= target) (required).
 *   @param {number} [opts.budget]       — per-round adjudication budget (clamped 1..50).
 *   @param {number} [opts.maxRounds]    — hard loop ceiling (default 50).
 *   @param {string} [opts.daemonUrl]    — daemon base URL the in-process judge calls (default DAEMON_BASE_URL).
 *   @param {object} [opts.deps]         — test seams: { backendDeps, overlayLoad, judgeLib, timeoutMs }.
 * @returns {Promise<{ judged:number, kept:number, pruned:number, idle:boolean, rounds:number, skipped?:string }>}
 */
async function runJudgeDrainSync(opts = {}) {
  const workspaceRoot = opts.workspaceRoot || SELF_REPO;
  const node = opts.node ? String(opts.node) : null;
  if (!node) return { judged: 0, kept: 0, pruned: 0, idle: true, rounds: 0, skipped: 'node_required' };

  const rawBudget = Number(opts.budget);
  const budget = Math.max(1, Math.min(Number.isFinite(rawBudget) ? rawBudget : DEFAULT_JUDGE_DRAIN_BUDGET, 50));
  const maxRounds = Math.max(1, Number(opts.maxRounds) || DEFAULT_SYNC_JUDGE_ROUNDS);
  const deps = opts.deps || {};
  // Same per-call timeout as the background drain (effectiveConfig().timeoutMs), overridable in tests.
  const timeoutMs = Math.max(1, Number(deps.timeoutMs) || effectiveConfig().timeoutMs);
  const daemonUrl = opts.daemonUrl || DAEMON_BASE_URL;

  // Make the active backend's creds available to the in-process judge, exactly like runDueDrains.
  try { loadEnvForClaude(SELF_REPO); } catch { /* best-effort */ }

  // Resolve the SAME backend the async drain uses. A skip (no usable/authed backend) is a clean
  // pause — report idle with the skip reason rather than crashing, mirroring runDueDrains.
  // mcpConfig is resolved for the agentic-cli path (the spawned CLI judge reaches the daemon's
  // orchestrator-graph MCP through it); the api path ignores it (it calls /judge/* over http directly).
  const overlay = _loadOverlayForBackend(workspaceRoot, deps);
  const mcpConfig = deps.mcpConfig || _resolveMcpConfig(workspaceRoot);
  const resolved = resolveJudgeBackend(overlay, { mcpConfig, addDir: workspaceRoot }, deps.backendDeps);
  if (resolved.skip) {
    return { judged: 0, kept: 0, pruned: 0, idle: _unjudgedEdgeCountForNode(workspaceRoot, node, deps) === 0, rounds: 0, skipped: resolved.skip };
  }
  const provider = resolved.provider;

  const active = (overlay && overlay.config && overlay.config.backend) || {};
  const model = resolved.model || active.model;
  const key = active.key;

  let kept = 0;
  let pruned = 0;
  let rounds = 0;
  const before = _unjudgedEdgeCountForNode(workspaceRoot, node, deps);

  // Loop the active judge until the node's candidate edge-set drains (idle), the budget/round
  // ceiling is hit, or a round fails/times out. Each round goes through the SHARED _runJudgeRound:
  //   - api kind  ⇒ the EXACT in-process runJudgeLoop path _runOneJudge takes;
  //   - cli kind  ⇒ the configured provider's invocation (claude/codex/cursor — GENERIC) SPAWNED via
  //                 runDrain, the SAME machinery the background cli drain uses.
  // EVERY round is wrapped in _withCallTimeout (the SAME per-call bound as the background drain), and
  // the cli spawn is ADDITIONALLY bounded inside runDrain by the same timeoutMs + child.kill('SIGKILL')
  // — so the old cli/spawn hang class cannot return. The node-scoped prompt is buildJudgePrompt (no
  // second prompt); for the api path the prompt is unused (runJudgeLoop builds its own messages).
  for (; rounds < maxRounds; rounds++) {
    const unjudgedBefore = _unjudgedEdgeCountForNode(workspaceRoot, node, deps);
    if (unjudgedBefore === 0) break; // idle reached
    const { prompt } = buildJudgePrompt({ budget, node, model, workspace: workspaceRoot, daemonUrl });
    const result = await _withCallTimeout(
      _runJudgeRound({ provider, node, prompt, model, budget, key, mcpConfig, workspaceRoot, timeoutMs }),
      timeoutMs
    );
    const counts = _parseAppliedCounts(result && result.stdout);
    kept += counts.kept;
    pruned += counts.pruned;
    // Stop on a failed/timed-out round (exitCode != 0): the hang-guard or an API error fired — do not
    // spin re-firing into it. The partial counts so far are still returned.
    if (!result || result.timedOut || (result.exitCode !== undefined && result.exitCode !== 0)) {
      rounds++;
      break;
    }
    // An idle round (api runJudgeLoop reports "idle"/"no items") means we are done — guard against a
    // queue that reports work in the overlay but returns nothing over HTTP, so the loop can't spin.
    if (/judge idle|no items returned/.test(String(result.stdout || ''))) { rounds++; break; }
    // BACKEND-AGNOSTIC stall guard (covers the cli path, whose stream-json stdout carries neither the
    // idle marker nor applied=counts): if a CLEAN round drained nothing — the node's unjudged set is
    // unchanged AND no kept/pruned were parsed — re-firing the same round won't make progress, so stop
    // rather than spawn maxRounds identical CLIs into a queue the round can't drain.
    if (counts.kept + counts.pruned === 0
        && _unjudgedEdgeCountForNode(workspaceRoot, node, deps) >= unjudgedBefore) {
      rounds++;
      break;
    }
  }

  const after = _unjudgedEdgeCountForNode(workspaceRoot, node, deps);
  // judged = how many of the node's candidate edges left the unjudged set (kept+pruned both remove an
  // edge from "unjudged"). Falls back to kept+pruned when the overlay delta is unavailable.
  const judgedByDelta = Math.max(0, before - after);
  const judged = judgedByDelta || (kept + pruned);
  return { judged, kept, pruned, idle: after === 0, rounds };
}

/**
 * Load the workspace overlay for backend resolution. Uses the SAME loader findDueJudgeWork uses
 * (injectable via deps.overlayLoad) so a test that mocks judge due-detection also drives the backend
 * off one synthetic overlay. Any failure is swallowed and reported as an empty overlay ({}) — that
 * resolves to the Claude default in getActiveBackend, so a missing overlay never throws here.
 */
function _loadOverlayForBackend(workspaceRoot, deps = {}) {
  try {
    const overlayLoad = (deps && deps.overlayLoad) || require('./overlay').load;
    return overlayLoad(workspaceRoot) || {};
  } catch {
    return {};
  }
}

/**
 * Resolve the mcp-config that grants the headless judge the orchestrator-graph MCP tools.
 *
 * PREFERS an HTTP mcp-config pointing at the daemon's SHARED /mcp endpoint (routes/meta.js — the
 * same handleRpc core as the stdio relay) over the portable stdio `.mcp.json`. With stdio, the
 * judge's claude.exe FORKS its own `node mcp-graph.js` per run — a 1:1 private-pipe MCP server that
 * on Windows leaks a console window per judge. HTTP is many-to-1: every judge (and the foreground)
 * shares the one daemon-hosted server, so nothing is forked and no window appears. The daemon is
 * always up when a judge runs (it spawned the judge), so the endpoint is reachable. Falls back to
 * the stdio `.mcp.json` if the http config can't be written, so judging never breaks.
 */
function _resolveMcpConfig(workspaceRoot) {
  const fs = require('fs');
  // Preferred: shared HTTP MCP — no per-judge stdio `node mcp-graph.js` fork (the Windows window leak).
  try {
    const { runtimePath } = require('./runtime-paths');
    const port = Number(process.env.ORCH_PORT) || 8787;
    const url = `http://127.0.0.1:${port}/mcp?workspace=${encodeURIComponent(workspaceRoot)}`;
    const cfg = { mcpServers: { 'orchestrator-graph': { type: 'http', url } } };
    const dir = runtimePath('judge-mcp');
    fs.mkdirSync(dir, { recursive: true });
    // One stable file per workspace (the url bakes in the workspace), keyed by a short hash so the
    // raw path's `:`/`\` never hit the filename. Lives in the runtime dir, NOT .graph (no snapshot).
    const hash = require('crypto').createHash('sha1').update(String(workspaceRoot)).digest('hex').slice(0, 16);
    const cfgPath = path.join(dir, `http-${hash}.json`);
    fs.writeFileSync(cfgPath, JSON.stringify(cfg));
    return cfgPath;
  } catch { /* fall through to the portable stdio config */ }
  // Fallback: the committable stdio `.mcp.json` (forks node mcp-graph.js — used only if the http
  // config above could not be written).
  for (const cand of [path.join(workspaceRoot, '.mcp.json'), path.join(SELF_REPO, '.mcp.json')]) {
    try { if (fs.existsSync(cand)) return cand; } catch { /* ignore */ }
  }
  return null;
}

// ---- dashboard progress reporting ---------------------------------------------------

/**
 * Drain progress used to be reported through POST /overlay/note. That polluted durable knowledge:
 * each "headless-drain completed" telemetry note was autowired, queued for judging, and caused the
 * drain to create more judge work for itself. Until there is a dedicated telemetry endpoint, progress
 * reporting must be a no-op.
 */
async function _reportDrainProgress(_summary, _httpModule) {}

module.exports = {
  HEADLESS_DRAIN_CONFIG,
  LEARNER_DRAIN_KEY,
  JUDGE_DRAIN_KEY,
  LABEL_DRAIN_KEY,
  REVIEW_MERGE_DRAIN_KEY,
  isHeadlessEnabled,
  runDrain,
  runDueDrains,
  _governor,
  // Exported for tests:
  buildLearnerArgs,
  findPendingLearnerRepos,
  findPendingLearnerQueues,
  buildJudgeArgs,
  buildJudgePrompt,
  resolveJudgeBackend,
  runJudgeDrainSync,
  findDueJudgeWork,
  claimDueJudgeWork,
  buildLabelArgs,
  findDueLabelWork,
  findReviewMergeCandidates,
  runReviewMergeDrain,
  effectiveConfig,
  isThrottled,
  recordDrainOutcome,
  commitGraphSnapshot,
  backoffConfig,
  _acquireGlobalDrainSlot: acquireGlobalDrainSlot,
  _releaseGlobalDrainSlot: releaseGlobalDrainSlot,
  _drainLeaseFile: drainLeaseFile,
  _resolveMcpConfig,
  DEFAULT_JUDGE_DRAIN_BUDGET,
};
