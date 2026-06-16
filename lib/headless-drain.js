'use strict';
/**
 * headless-drain.js — daemon-internal runner + governor for headless `claude -p` drain processes.
 *
 * DESIGN
 * ------
 * Enables the passive daemon (no live session) to run background maintenance tasks by spawning
 * headless `claude -p` child processes instead of dispatching to an interactive agent session.
 * This is the "no-session path": real ready-task impl work remains session-dispatched; this module
 * only handles standing background drains (learner, and later judge/label).
 *
 * SAFETY GATE
 * -----------
 * The opt-in env flag `ORCH_HEADLESS_DRAINS` MUST be set to a truthy value for ANY spawn to occur.
 * When unset or falsey the runner is a strict no-op — nothing is ever spawned. This is the
 * primary safety gate: a misconfigured daemon cannot accidentally fork-bomb claude processes.
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
 *   isHeadlessEnabled()    — true iff ORCH_HEADLESS_DRAINS is truthy.
 *   runDrain(spec)         — spawn one drain child and return { exitCode, stdout, timedOut }.
 *   runDueDrains(state, ov) — check governor budget/concurrency and run any due drains.
 *   _governor              — mutable governor state (exported for tests / reset between runs).
 */

const { spawnSync } = require('child_process');
const path = require('path');
const { resolveClaudeBin, loadEnvForClaude, needsShell } = require('./claude-cli');

// ---- constants -----------------------------------------------------------------------

const SELF_REPO = path.resolve(__dirname, '..');

// Default governor config — mirrors AUTOSTART_CONFIG shape from lib/loop-autostart.js.
// These are conservative defaults; override via HEADLESS_DRAIN_* env vars (see below).
const HEADLESS_DRAIN_CONFIG = {
  tokenBudget: 200000,      // max tokens the drain pool may spend per daemon boot (soft)
  maxIterations: 50,        // max total drain-run spawns across all drains
  maxConcurrency: 2,        // max simultaneously running drain child processes
  timeoutMs: 10 * 60 * 1000, // per-run wall-clock timeout (10 minutes, matches onboard-learn)
};

// ---- opt-in safety gate --------------------------------------------------------------

/**
 * Returns true iff ORCH_HEADLESS_DRAINS is set to a truthy value.
 * When this returns false, runDrain() and runDueDrains() are strict no-ops.
 */
function isHeadlessEnabled() {
  const v = process.env.ORCH_HEADLESS_DRAINS;
  if (!v) return false;
  return v !== '0' && v.toLowerCase() !== 'false' && v.toLowerCase() !== 'no';
}

// ---- mutable governor state ----------------------------------------------------------
// Exported so tests can reset it between runs without re-requiring the module.

const _governor = {
  iterationsUsed: 0,
  tokensUsed: 0,
  concurrentRunning: 0,
};

// ---- effective config ----------------------------------------------------------------

function effectiveConfig() {
  return {
    tokenBudget: Number(process.env.HEADLESS_DRAIN_TOKEN_BUDGET) || HEADLESS_DRAIN_CONFIG.tokenBudget,
    maxIterations: Number(process.env.HEADLESS_DRAIN_MAX_ITERATIONS) || HEADLESS_DRAIN_CONFIG.maxIterations,
    maxConcurrency: Number(process.env.HEADLESS_DRAIN_MAX_CONCURRENCY) || HEADLESS_DRAIN_CONFIG.maxConcurrency,
    timeoutMs: Number(process.env.HEADLESS_DRAIN_TIMEOUT_MS) || HEADLESS_DRAIN_CONFIG.timeoutMs,
  };
}

// ---- single-drain runner -------------------------------------------------------------

/**
 * Spawn one headless drain run synchronously.
 *
 * @param {object} spec
 *   @param {string}   spec.bin     — absolute path to the `claude` binary (from resolveClaudeBin)
 *   @param {string[]} spec.args    — argv passed to `claude` (e.g. ['-p', prompt, ...])
 *   @param {string}   spec.cwd     — working directory for the child
 *   @param {number}   spec.timeoutMs — wall-clock timeout; child is SIGKILL'd after this
 *
 * @returns {{ exitCode: number|null, stdout: string, stderr: string, timedOut: boolean }}
 *
 * NOTE: Uses spawnSync (blocking) — this is intentional. The daemon's setInterval fires
 * asynchronously and the drain interval is long (minutes), so a blocking sync call here
 * keeps the implementation simple and avoids async state leaks. The timer is unref'd so
 * it never holds the process open; a long sync call just delays the next daemon heartbeat
 * slightly, which is acceptable for a background maintenance path.
 *
 * The SAFETY GATE is checked by the caller (runDueDrains). runDrain itself does NOT check
 * isHeadlessEnabled() — callers are responsible for gating.
 */
function runDrain(spec) {
  const { bin, args, cwd, timeoutMs } = spec;
  const shell = needsShell(bin);

  const result = spawnSync(bin, args, {
    cwd: cwd || SELF_REPO,
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    timeout: timeoutMs,
    killSignal: 'SIGKILL',
    shell,
  });

  const timedOut = !!(result.error && result.error.code === 'ETIMEDOUT');
  return {
    exitCode: result.status,
    stdout: result.stdout || '',
    stderr: result.stderr || '',
    timedOut,
    spawnError: result.error ? result.error.message : null,
  };
}

// ---- multi-drain orchestrator --------------------------------------------------------

/**
 * Definition of the LEARNER drain — the only first-party drain wired in this task.
 * Judge and label drains are out of scope (separate downstream tasks).
 *
 * A drain spec has:
 *   key      — the graph task key this drain corresponds to (for dashboard reporting)
 *   buildArgs(repoAbs) — returns argv array for `claude`
 *   getCwd(repoAbs)    — returns the working directory for the spawn
 */
const LEARNER_DRAIN_KEY = 'followup/harness-learner-drain';

/**
 * Build the argv for the learner drain invocation.
 * Mirrors what `node scripts/onboard-learn.js --drain --repo <abs>` does — but we call
 * `node` directly so the drain runner is not dependent on the system having `node` on PATH
 * (it's the same Node that runs the daemon).
 */
function buildLearnerArgs(repoAbs) {
  const script = path.join(SELF_REPO, 'scripts', 'onboard-learn.js');
  return [script, '--drain', '--repo', repoAbs];
}

/**
 * Find repos that have a pending onboard queue (i.e. `onboard-queue.json` with cursor < total).
 * Returns an array of absolute repo paths.
 *
 * This is a best-effort scan — it reads the .graph/onboard/onboard-queue.json file in the
 * current workspace repo. If none are found, runDueDrains is a fast no-op.
 */
function findPendingLearnerRepos(workspaceRoot) {
  const fs = require('fs');
  const candidates = [workspaceRoot];
  const due = [];
  for (const repo of candidates) {
    try {
      const qf = path.join(repo, '.graph', 'onboard', 'onboard-queue.json');
      const raw = fs.readFileSync(qf, 'utf8').replace(/^﻿/, '');
      const q = JSON.parse(raw);
      if (q && typeof q.cursor === 'number' && typeof q.total === 'number' && q.cursor < q.total) {
        due.push(repo);
      }
    } catch { /* queue file absent or unreadable — skip */ }
  }
  return due;
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
 * @returns {{ ran: number, skipped: string, drains: Array }} summary of what happened.
 */
function runDueDrains(state, daemonHttp) {
  // ---- safety gate -----------------------------------------------------------------
  if (!isHeadlessEnabled()) {
    return { ran: 0, skipped: 'flag_off', drains: [] };
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

  // ---- load the .env so ANTHROPIC_API_KEY is available to the child ----------------
  loadEnvForClaude(SELF_REPO);

  const bin = resolveClaudeBin();
  const workspaceRoot = (state && state.workspace) || SELF_REPO;
  const drainResults = [];

  // ---- LEARNER drain ---------------------------------------------------------------
  const pendingRepos = findPendingLearnerRepos(workspaceRoot);
  for (const repoAbs of pendingRepos) {
    if (_governor.iterationsUsed >= cfg.maxIterations) break;
    if (_governor.concurrentRunning >= cfg.maxConcurrency) break;

    _governor.concurrentRunning++;
    _governor.iterationsUsed++;

    const args = buildLearnerArgs(repoAbs);
    // Use `node` as the executable (not `claude`) for onboard-learn.js — it's a Node script.
    const nodeArgs = [path.join(SELF_REPO, 'scripts', 'onboard-learn.js'), '--drain', '--repo', repoAbs];
    const nodeBin = process.execPath; // same Node that runs the daemon

    process.stdout.write(`[headless-drain] LEARNER starting for repo=${repoAbs}\n`);

    let drainResult;
    try {
      drainResult = runDrain({
        bin: nodeBin,
        args: nodeArgs,
        cwd: repoAbs,
        timeoutMs: cfg.timeoutMs,
      });
    } finally {
      _governor.concurrentRunning = Math.max(0, _governor.concurrentRunning - 1);
    }

    const summary = {
      drain: LEARNER_DRAIN_KEY,
      repo: repoAbs,
      exitCode: drainResult.exitCode,
      timedOut: drainResult.timedOut,
      spawnError: drainResult.spawnError,
    };
    drainResults.push(summary);

    if (drainResult.exitCode === 0 && !drainResult.timedOut) {
      process.stdout.write(`[headless-drain] LEARNER done for repo=${repoAbs} exit=0\n`);
    } else {
      process.stdout.write(
        `[headless-drain] LEARNER FAILED repo=${repoAbs} exit=${drainResult.exitCode} timedOut=${drainResult.timedOut}\n`
      );
    }

    // Report progress back to the graph so the dashboard reflects drain activity.
    // Best-effort — if the daemon HTTP call fails, the drain still ran.
    _reportDrainProgress(summary, daemonHttp).catch(() => {});
  }

  return { ran: drainResults.length, skipped: drainResults.length ? null : 'no_due_drains', drains: drainResults };
}

// ---- dashboard progress reporting ---------------------------------------------------

/**
 * Post a brief progress note back to the daemon so the dashboard can show drain activity.
 * Calls POST /overlay/note to attach a transient note to the learner-drain task.
 * Best-effort: failures are silently swallowed by the caller.
 */
async function _reportDrainProgress(summary, httpModule) {
  const http = httpModule || require('http');
  const port = Number(process.env.ORCH_PORT) || 8787;
  const note = summary.timedOut
    ? `headless-drain: LEARNER timed out for ${path.basename(summary.repo)}`
    : summary.exitCode === 0
      ? `headless-drain: LEARNER completed for ${path.basename(summary.repo)}`
      : `headless-drain: LEARNER failed (exit=${summary.exitCode}) for ${path.basename(summary.repo)}`;

  const body = JSON.stringify({
    title: note,
    summary: `drain=${summary.drain} repo=${summary.repo} exit=${summary.exitCode} timedOut=${summary.timedOut}`,
    created_by: 'headless-drain',
    knowledge: [`drain:${summary.drain}`, `exit:${summary.exitCode}`],
  });

  return new Promise((resolve) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path: '/overlay/note', method: 'POST',
        headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body) } },
      (res) => { res.resume(); res.on('end', resolve); }
    );
    req.on('error', resolve); // best-effort
    req.write(body);
    req.end();
  });
}

module.exports = {
  HEADLESS_DRAIN_CONFIG,
  LEARNER_DRAIN_KEY,
  isHeadlessEnabled,
  runDrain,
  runDueDrains,
  _governor,
  // Exported for tests:
  buildLearnerArgs,
  findPendingLearnerRepos,
  effectiveConfig,
};
