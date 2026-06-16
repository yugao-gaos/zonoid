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

const { spawn } = require('child_process');
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
 * Spawn one headless drain run ASYNCHRONOUSLY and resolve when the child exits.
 *
 * @param {object} spec
 *   @param {string}   spec.bin     — absolute path to the `claude` binary (from resolveClaudeBin)
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
 * until the 10-minute timeout SIGKILL'd it. With async spawn the event loop stays free while the
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
  const { bin, args, cwd, timeoutMs } = spec;
  const shell = needsShell(bin);
  const MAX_BUFFER = 32 * 1024 * 1024;

  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(bin, args, { cwd: cwd || SELF_REPO, shell, windowsHide: true });
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
 * spawns a real headless `claude -p` that drives the self-learn-edge-judge skill against the
 * daemon. The LABEL drain spawns a Node script (scripts/gate-label.js) — a DETERMINISTIC labeler
 * (no `claude -p`), wired exactly like the LEARNER consumer (a Node child through this runner).
 */
const LEARNER_DRAIN_KEY = 'followup/harness-learner-drain';

// Stable key for the standing "harness: judge drain" task — MUST match routes/judge.js
// HARNESS_JUDGE_DRAIN_KEY so dashboard progress notes attach to the same node the route ensures.
const JUDGE_DRAIN_KEY = 'followup/harness-judge-drain';

// Stable key for the standing "harness: label drain" task — MUST match routes/label.js
// HARNESS_LABEL_DRAIN_KEY so dashboard progress notes attach to the same node the route ensures.
const LABEL_DRAIN_KEY = 'followup/harness-label-drain';

// Default daemon base URL the headless judge drives over HTTP (/judge/next + /judge/verdict).
const DAEMON_BASE_URL = `http://localhost:${Number(process.env.ORCH_PORT) || 8787}`;

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

// ---- JUDGE drain ---------------------------------------------------------------------

/**
 * Build the argv for ONE headless judge-drain `claude -p` invocation.
 *
 * The spawned agent drives the `self-learn-edge-judge` skill against the daemon over HTTP,
 * covering BOTH queue paths:
 *   - PERIODIC (node omitted): GET /judge/next?budget=N — the depth-driven cursor-walked queue.
 *   - EAGER  (node set):       GET /judge/next?node=<key>&budget=N — the node-scoped path for a
 *                              freshly-wired node pending eager judgment.
 * In both cases the agent reasons each item and POSTs /judge/verdict, bounded to the budget.
 *
 * Mirrors the flag set scripts/onboard-learn.js uses for its headless `claude -p` run, but —
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
function buildJudgeArgs(opts = {}) {
  // Default only when budget is absent/non-numeric; a provided number is CLAMPED to 1..50 (so an
  // explicit 0 floors to 1 rather than silently jumping to the default).
  const rawBudget = Number(opts.budget);
  const budget = Math.max(1, Math.min(Number.isFinite(rawBudget) ? rawBudget : 6, 50));
  const node = opts.node ? String(opts.node) : null;
  const daemonUrl = opts.daemonUrl || DAEMON_BASE_URL;
  const model = opts.model || process.env.HEADLESS_DRAIN_JUDGE_MODEL || 'opus';

  // The endpoint the agent should pull from — encodes periodic vs eager so the prompt is unambiguous.
  const nextPath = node
    ? `/judge/next?node=${encodeURIComponent(node)}&budget=${budget}`
    : `/judge/next?budget=${budget}`;

  const prompt = [
    `Invoke the self-learn-edge-judge skill in single-pass headless mode against the orchestrator daemon at ${daemonUrl}.`,
    node
      ? `EAGER path: pull this node's unjudged candidate edge-set in one slice via GET ${daemonUrl}${nextPath} (node-scoped, node=${node}).`
      : `PERIODIC path: pull the depth-driven queue via GET ${daemonUrl}${nextPath} (cursor-walked).`,
    `Reason each returned item per the skill's conservative criteria and apply your decisions with POST ${daemonUrl}/judge/verdict.`,
    `Adjudicate AT MOST ${budget} items this run, then stop — do NOT loop, fan out, or re-walk the queue. If /judge/next returns idle:true, stop immediately.`,
  ].join(' ');

  const args = ['-p', prompt, '--model', model, '--output-format', 'stream-json', '--verbose', '--dangerously-skip-permissions'];
  if (opts.mcpConfig) args.push('--mcp-config', opts.mcpConfig, '--strict-mcp-config');
  if (opts.addDir) args.push('--add-dir', opts.addDir);
  return args;
}

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
 * @param {object} [deps] — { overlayLoad(workspace)=>overlay, judgeLib={buildQueue,eagerJudgeNodes} }
 */
function findDueJudgeWork(workspaceRoot, deps = {}) {
  const none = { periodic: false, eagerNodes: [], depth: 0 };
  try {
    const overlayLoad = deps.overlayLoad || require('./overlay').load;
    const judgeLib = deps.judgeLib || require('./judge');
    const overlay = overlayLoad(workspaceRoot);
    if (!overlay) return none;
    const queue = judgeLib.buildQueue(overlay) || [];
    const eagerNodes = judgeLib.eagerJudgeNodes(overlay) || [];
    return { periodic: queue.length > 0, eagerNodes, depth: queue.length };
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
 * (gate-journal.jsonl → .graph/gate-labeled.jsonl), NOT a `claude -p` agent.
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
 * ASYNC: awaits each runDrain so the daemon's event loop stays free during every child run (the
 * deadlock fix). The daemon's setInterval trigger fires-and-forgets the returned Promise with a
 * .catch — it does NOT await it (see daemon.js), so a long drain never stalls the timer or any
 * other sweep.
 */
async function runDueDrains(state, daemonHttp, options = {}) {
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

    // Use `node` as the executable (not `claude`) for onboard-learn.js — it's a Node script.
    const nodeArgs = [path.join(SELF_REPO, 'scripts', 'onboard-learn.js'), '--drain', '--repo', repoAbs];
    const nodeBin = process.execPath; // same Node that runs the daemon

    process.stdout.write(`[headless-drain] LEARNER starting for repo=${repoAbs}\n`);

    let drainResult;
    try {
      drainResult = await runDrain({
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

  // ---- JUDGE drain -----------------------------------------------------------------
  // Drives the self-learn-edge-judge skill via a real headless `claude -p` against the daemon,
  // covering BOTH the eager (node-scoped) and periodic (cursor-walked) /judge/next paths. Rides
  // the SAME governor as the learner above — no second spawn/resolve path. Eager nodes are judged
  // first (freshly-wired, latency-sensitive), then ONE periodic batch fills any remaining slot.
  const due = findDueJudgeWork(workspaceRoot, options.judgeDeps);
  if (due.eagerNodes.length || due.periodic) {
    const mcpConfig = _resolveMcpConfig(workspaceRoot);
    const judgeBudget = Number(process.env.HEADLESS_DRAIN_JUDGE_BUDGET) || 6;

    // EAGER: one node-scoped run per pending node, bounded by the governor.
    for (const node of due.eagerNodes) {
      if (_governor.iterationsUsed >= cfg.maxIterations) break;
      if (_governor.concurrentRunning >= cfg.maxConcurrency) break;
      await _runOneJudge({ node, mode: 'eager', cfg, bin, mcpConfig, workspaceRoot, judgeBudget, daemonHttp, drainResults });
    }

    // PERIODIC: a single bounded batch if the cursor-walked queue still has depth and a slot remains.
    if (due.periodic
        && _governor.iterationsUsed < cfg.maxIterations
        && _governor.concurrentRunning < cfg.maxConcurrency) {
      await _runOneJudge({ node: null, mode: 'periodic', cfg, bin, mcpConfig, workspaceRoot, judgeBudget, daemonHttp, drainResults });
    }
  }

  // ---- LABEL drain -----------------------------------------------------------------
  // Runs the DETERMINISTIC gate-labeler (node scripts/gate-label.js) headless under the SAME
  // governor as the learner/judge — no second spawn/resolve path. Mirrors the LEARNER consumer:
  // a Node child via process.execPath (NOT `claude -p`). One bounded run per pass is sufficient —
  // gate-label.js drains the entire gradable backlog in a single idempotent invocation.
  const labelDue = findDueLabelWork(workspaceRoot, options.labelDeps);
  if (labelDue.due
      && _governor.iterationsUsed < cfg.maxIterations
      && _governor.concurrentRunning < cfg.maxConcurrency) {
    _governor.concurrentRunning++;
    _governor.iterationsUsed++;

    const nodeBin = process.execPath; // same Node that runs the daemon
    const labelArgs = buildLabelArgs(workspaceRoot, Number(process.env.ORCH_PORT) || 8787);

    process.stdout.write(`[headless-drain] LABEL starting pending=${labelDue.pending}\n`);

    let drainResult;
    try {
      drainResult = await runDrain({
        bin: nodeBin,
        args: labelArgs,
        cwd: workspaceRoot,
        timeoutMs: cfg.timeoutMs,
      });
    } finally {
      _governor.concurrentRunning = Math.max(0, _governor.concurrentRunning - 1);
    }

    const summary = {
      drain: LABEL_DRAIN_KEY,
      pending: labelDue.pending,
      exitCode: drainResult.exitCode,
      timedOut: drainResult.timedOut,
      spawnError: drainResult.spawnError,
    };
    drainResults.push(summary);

    if (drainResult.exitCode === 0 && !drainResult.timedOut) {
      process.stdout.write(`[headless-drain] LABEL done pending=${labelDue.pending} exit=0\n`);
    } else {
      process.stdout.write(
        `[headless-drain] LABEL FAILED pending=${labelDue.pending} exit=${drainResult.exitCode} timedOut=${drainResult.timedOut}\n`
      );
    }

    _reportDrainProgress(summary, daemonHttp).catch(() => {});
  }

  return { ran: drainResults.length, skipped: drainResults.length ? null : 'no_due_drains', drains: drainResults };
}

/**
 * Run ONE judge-drain `claude -p` invocation through the governor and record its summary.
 * Shared by the eager and periodic paths so both go through the identical spawn + accounting code
 * (the whole point: no duplicate spawn path). Mutates _governor + pushes onto drainResults.
 *
 * ASYNC: awaits runDrain (the deadlock fix) so the daemon event loop stays free while the headless
 * `claude -p` child runs — that child calls BACK into this daemon over HTTP (GET /judge/next +
 * POST /judge/verdict), so blocking here is precisely what would deadlock. Callers await this.
 * @returns {Promise<void>}
 */
async function _runOneJudge({ node, mode, cfg, bin, mcpConfig, workspaceRoot, judgeBudget, daemonHttp, drainResults }) {
  _governor.concurrentRunning++;
  _governor.iterationsUsed++;

  const args = buildJudgeArgs({
    budget: judgeBudget,
    node: node || undefined,
    mcpConfig: mcpConfig || undefined,
    addDir: workspaceRoot,
  });

  process.stdout.write(`[headless-drain] JUDGE starting mode=${mode}${node ? ` node=${node}` : ''}\n`);

  let drainResult;
  try {
    drainResult = await runDrain({ bin, args, cwd: workspaceRoot, timeoutMs: cfg.timeoutMs });
  } finally {
    _governor.concurrentRunning = Math.max(0, _governor.concurrentRunning - 1);
  }

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

/**
 * Resolve the workspace `.mcp.json` that grants the headless judge the orchestrator-graph MCP.
 * Returns the path if it exists, else null (the judge still works skill-only over HTTP without it).
 */
function _resolveMcpConfig(workspaceRoot) {
  const fs = require('fs');
  for (const cand of [path.join(workspaceRoot, '.mcp.json'), path.join(SELF_REPO, '.mcp.json')]) {
    try { if (fs.existsSync(cand)) return cand; } catch { /* ignore */ }
  }
  return null;
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
  // Drain-agnostic label + target: LEARNER carries a repo; JUDGE carries a mode (+ optional node);
  // LABEL carries a pending count.
  const label = summary.drain === JUDGE_DRAIN_KEY
    ? 'JUDGE'
    : summary.drain === LABEL_DRAIN_KEY
      ? 'LABEL'
      : 'LEARNER';
  const target = summary.repo
    ? path.basename(summary.repo)
    : summary.node
      ? `${summary.mode || 'judge'}:${summary.node}`
      : summary.drain === LABEL_DRAIN_KEY
        ? `pending=${summary.pending != null ? summary.pending : '?'}`
        : (summary.mode || 'judge');
  const note = summary.timedOut
    ? `headless-drain: ${label} timed out for ${target}`
    : summary.exitCode === 0
      ? `headless-drain: ${label} completed for ${target}`
      : `headless-drain: ${label} failed (exit=${summary.exitCode}) for ${target}`;

  const body = JSON.stringify({
    title: note,
    summary: `drain=${summary.drain} target=${target} exit=${summary.exitCode} timedOut=${summary.timedOut}`,
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
  JUDGE_DRAIN_KEY,
  LABEL_DRAIN_KEY,
  isHeadlessEnabled,
  runDrain,
  runDueDrains,
  _governor,
  // Exported for tests:
  buildLearnerArgs,
  findPendingLearnerRepos,
  buildJudgeArgs,
  findDueJudgeWork,
  buildLabelArgs,
  findDueLabelWork,
  effectiveConfig,
};
