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
  backoffUntil: 0,          // ms epoch; runDueDrains no-ops while Date.now() < this (rate-limit/overload backoff)
  consecutiveThrottles: 0,  // grows the backoff window per consecutive throttle; reset on a clean run
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

// ---- rate-limit / overload backoff ---------------------------------------------------
// The drains call a metered LLM API; under 429/529/overload they must RETREAT, not keep firing
// every tick (which amplifies the overload and burns quota). We scan the child's output for a
// throttle signal and set _governor.backoffUntil; runDueDrains no-ops until it passes. The window
// grows exponentially per consecutive throttle (capped) and resets on the first clean run.
const BACKOFF_BASE_MS = 5 * 60 * 1000;    // first backoff window
const BACKOFF_CAP_MS = 60 * 60 * 1000;    // max backoff window

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

// Fold one LLM-drain outcome into the governor's backoff: a throttle (or a timeout — a strong
// "trouble" signal) grows the window exponentially (capped); a clean run (exit 0, not timed out,
// not throttled) RESETS it. Pure mutation on _governor; nowMs injected for tests. NOTE: only call
// this for LLM-backed drains (learner/judge) — NOT the deterministic label drain, which never hits
// the API and so must not reset an LLM backoff.
function recordDrainOutcome(result, nowMs = Date.now()) {
  if (!result) return;
  if (isThrottled(result) || result.timedOut) {
    _governor.consecutiveThrottles += 1;
    const { baseMs, capMs } = backoffConfig();
    _governor.backoffUntil = nowMs + Math.min(capMs, baseMs * Math.pow(2, _governor.consecutiveThrottles - 1));
  } else if (result.exitCode === 0) {
    _governor.consecutiveThrottles = 0;
    _governor.backoffUntil = 0;
  }
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
  const { bin, args, cwd, timeoutMs, env } = spec;
  const shell = needsShell(bin);
  const MAX_BUFFER = 32 * 1024 * 1024;

  return new Promise((resolve) => {
    let child;
    try {
      // Forward an explicit env ONLY when the spec carries one (the selectable backend's
      // buildInvocation supplies it); absent ⇒ omit so the child inherits the parent env as before
      // (learner/label drains pass no env and must keep default inheritance — back-compat).
      const spawnOpts = { cwd: cwd || SELF_REPO, shell, windowsHide: true };
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
// Build the judge-drain PROMPT (the -p text) for a periodic or eager run, clamping budget to 1..50.
// Extracted from buildJudgeArgs so the SELECTABLE BACKEND path can hand this prompt to the active
// provider's buildInvocation() (which owns the flag set) instead of this module re-assembling argv.
// Pure; returns { prompt, budget, model }.
function buildJudgePrompt(opts = {}) {
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
    recordDrainOutcome(drainResult);   // LLM-backed (inner claude -p) — feed the rate-limit backoff

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
  // Drives the self-learn-edge-judge skill via the SELECTABLE BACKEND (lib/llm-backend) against the
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
  const due = findDueJudgeWork(workspaceRoot, options.judgeDeps);
  if (due.eagerNodes.length || due.periodic) {
    const mcpConfig = _resolveMcpConfig(workspaceRoot);
    const judgeBudget = Number(process.env.HEADLESS_DRAIN_JUDGE_BUDGET) || 6;

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
      // Per-TICK cap on judge spawns (distinct from maxIterations, which is per daemon boot): a burst
      // of freshly-wired eager nodes must NOT fire many heavyweight agent spawns back-to-back in one
      // tick. The excess stays pending and rides the next tick.
      const maxPerTick = Number(process.env.HEADLESS_DRAIN_MAX_PER_TICK) || 2;
      let judgeSpawnsThisTick = 0;

      // EAGER: one node-scoped run per pending node, bounded by the governor AND the per-tick cap —
      // the cap bounds the EAGER burst (1 spawn per freshly-wired node); the excess rides later ticks.
      for (const node of due.eagerNodes) {
        if (judgeSpawnsThisTick >= maxPerTick) break;
        if (_governor.iterationsUsed >= cfg.maxIterations) break;
        if (_governor.concurrentRunning >= cfg.maxConcurrency) break;
        await _runOneJudge({ node, mode: 'eager', cfg, provider, overlay, judgeBudget, mcpConfig, workspaceRoot, daemonHttp, drainResults });
        judgeSpawnsThisTick++;
      }

      // PERIODIC: a single bounded batch if the cursor-walked queue still has depth and a slot remains.
      // (Not subject to the per-tick EAGER cap — it's one batch, not a per-node burst.)
      if (due.periodic
          && _governor.iterationsUsed < cfg.maxIterations
          && _governor.concurrentRunning < cfg.maxConcurrency) {
        await _runOneJudge({ node: null, mode: 'periodic', cfg, provider, overlay, judgeBudget, mcpConfig, workspaceRoot, daemonHttp, drainResults });
      }
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

  // Skip reason precedence when nothing ran: a judge HARD-BLOCK / api-skip is more informative than
  // the generic 'no_due_drains' (it tells the dashboard WHY a due judge produced no spawn). If any
  // drain ran, skipped is null regardless (the judge skip is non-fatal, other drains still count).
  const skipped = drainResults.length ? null : (judgeSkipReason || 'no_due_drains');
  return { ran: drainResults.length, skipped, drains: drainResults };
}

/**
 * Run ONE judge-drain invocation through the governor and record its summary. Two backend kinds share
 * this single accounting path (the whole point: no duplicate path):
 *   - agentic-cli: `provider.buildInvocation({prompt,model,mcpConfig,addDir})` returns the spawnable
 *     { bin, args, env } (mirrors the historical `claude -p` flag set); runDrain SPAWNS a child.
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
async function _runOneJudge({ node, mode, cfg, provider, overlay, mcpConfig, workspaceRoot, judgeBudget, daemonHttp, drainResults }) {
  _governor.concurrentRunning++;
  _governor.iterationsUsed++;

  // Build the per-call prompt opts (node-scoped for eager, cursor-walked for periodic). buildJudgePrompt
  // clamps the budget identically for both kinds; model defaults to the dashboard-selected backend model.
  const active = (overlay && overlay.config && overlay.config.backend) || {};
  const { prompt, model, budget } = buildJudgePrompt({
    budget: judgeBudget,
    node: node || undefined,
    model: active.model,
  });

  process.stdout.write(`[headless-drain] JUDGE starting mode=${mode}${node ? ` node=${node}` : ''} provider=${provider.id} kind=${provider.kind}\n`);

  let drainResult;
  try {
    if (provider.kind === 'api') {
      // IN-PROCESS api judge: no spawn, no console window. runJudgeLoop drives the daemon's judge loop
      // over HTTP and resolves the drain-result shape. A throwing provider degrades to a clean failure
      // result (exitCode 1) so the drain pass never crashes on a misbehaving adapter.
      try {
        drainResult = await provider.runJudgeLoop({
          daemonUrl: DAEMON_BASE_URL,
          budget,
          node: node || undefined,
          model,
          key: active.key,
        });
      } catch (e) {
        drainResult = { exitCode: 1, stdout: '', stderr: `runJudgeLoop threw: ${e && e.message ? e.message : e}`, timedOut: false, spawnError: null };
      }
    } else {
      // agentic-cli: let the provider own the flag set, then SPAWN the child.
      const { bin, args, env } = provider.buildInvocation({
        prompt,
        model,
        mcpConfig: mcpConfig || undefined,
        addDir: workspaceRoot,
      });
      drainResult = await runDrain({ bin, args, env, cwd: workspaceRoot, timeoutMs: cfg.timeoutMs });
    }
  } finally {
    _governor.concurrentRunning = Math.max(0, _governor.concurrentRunning - 1);
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
  buildJudgePrompt,
  resolveJudgeBackend,
  findDueJudgeWork,
  buildLabelArgs,
  findDueLabelWork,
  effectiveConfig,
  isThrottled,
  recordDrainOutcome,
  backoffConfig,
};
