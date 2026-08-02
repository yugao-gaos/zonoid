#!/usr/bin/env node
// Persisted tuning knobs (lib/tuning.js) + the consumers that were env-only before:
// lib/headless-drain.effectiveConfig, lib/headless-spawn.workerTimeoutMs, the pump cadence in
// lib/headless-drain-runner.js, GET/POST /config/tuning, and the /status tuning view.
//
// Covers:
//   PRECEDENCE (the core contract: env > file > default)
//   (1) no tier set  ⇒ compiled-in default
//   (2) file set     ⇒ file wins over default
//   (3) env set      ⇒ env wins over file
//   (4) unset ≠ garbage: an unparseable tier falls to the DEFAULT, not to the lower tier
//   (5) unsetValue knobs (max_iterations) keep their historical unset semantics (unbounded)
//   (6) a malformed / unreadable tuning file never throws — it degrades to "no file tier"
//   (7) ZONOID_SKIP_LIVE suppresses the implicit real-runtime-dir file; ORCH_TUNING_FILE still wins
//   WRITE PATH
//   (8) write() merges + persists, null clears a knob, unknown/garbage knobs are rejected
//   (9) an mtime change is picked up without an explicit invalidate()
//   CONSUMERS
//  (10) effectiveConfig() resolves through the file tier (env still overrides)
//  (11) workerTimeoutMs() resolves through the file tier, keeping its 60s floor
//  (12) HOT RELOAD: a cadence knob written after the runner was built changes the NEXT delay on
//       that same live runner — the "no restart" claim, tested on the object that used to freeze it
//   ROUTES
//  (13) GET /config/tuning returns effective values + per-knob provenance
//  (14) POST /config/tuning writes, 400s on a bad knob, and needs no workspace
//  (15) GET /status carries the tuning view
//
// Run: node test/tuning-config.test.js
'use strict';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'tuning-test-'));
const FILE = path.join(TMP, 'tuning.json');
// Point the activity archive at the temp dir before routes/activity pulls lib/activity in.
process.env.ORCH_ACTIVITY_LOG = path.join(TMP, 'activity.jsonl');
process.env.ORCH_TUNING_FILE = FILE;

const tuning = require('../lib/tuning');

// Scrub every knob's env var out of THIS process. The route handlers resolve against process.env by
// design, and a developer machine legitimately exports HEADLESS_DRAIN_* (that is the pre-file way to
// tune the daemon) — without this, the ambient value silently wins and the file-tier assertions read
// as failures. Tests that exercise the env tier set it back explicitly.
for (const name of tuning.KNOB_NAMES) {
  for (const v of [tuning.KNOBS[name].env, ...(tuning.KNOBS[name].envAlso || [])]) delete process.env[v];
}

const writeFile = (obj) => { fs.writeFileSync(FILE, typeof obj === 'string' ? obj : JSON.stringify(obj)); tuning.invalidate(); };
const clearFile = () => { try { fs.unlinkSync(FILE); } catch { /* absent */ } tuning.invalidate(); };

// Every resolve takes an explicit env bag so a stray real HEADLESS_* var cannot flip a result.
const baseEnv = () => ({ ORCH_TUNING_FILE: FILE });

// ---- (1) default tier -------------------------------------------------------------------
{
  clearFile();
  const r = tuning.resolve('drain_max_concurrency', baseEnv());
  ok('(1) unset ⇒ compiled-in default', r.value === 2 && r.source === 'default');
  ok('(1) default for spawn_timeout_ms is 30min', tuning.get('spawn_timeout_ms', baseEnv()) === 30 * 60 * 1000);
}

// ---- (2) file over default --------------------------------------------------------------
{
  writeFile({ version: 1, tuning: { drain_max_concurrency: 6, spawn_timeout_ms: 3600000 } });
  const r = tuning.resolve('drain_max_concurrency', baseEnv());
  ok('(2) file wins over default', r.value === 6 && r.source === 'file');
  ok('(2) second knob from the same file', tuning.get('spawn_timeout_ms', baseEnv()) === 3600000);
  ok('(2) untouched knob still defaults', tuning.get('retry_delay_ms', baseEnv()) === 5000);
}

// ---- bare flat map is accepted too ------------------------------------------------------
{
  writeFile({ drain_max_concurrency: 4 });
  ok('(2b) bare flat map (no envelope) parses', tuning.get('drain_max_concurrency', baseEnv()) === 4);
}

// ---- (3) env over file ------------------------------------------------------------------
{
  writeFile({ version: 1, tuning: { drain_max_concurrency: 6 } });
  const r = tuning.resolve('drain_max_concurrency', { ...baseEnv(), HEADLESS_DRAIN_MAX_CONCURRENCY: '9' });
  ok('(3) env wins over file', r.value === 9 && r.source === 'env');
  // The legacy alias still resolves when the primary name is absent.
  const alias = tuning.resolve('idle_poll_ms', { ...baseEnv(), HEADLESS_DRAIN_INTERVAL_MS: '7000' });
  ok('(3) legacy env alias honoured', alias.value === 7000 && alias.source === 'env');
}

// ---- (4) garbage tier falls to DEFAULT, not to the lower tier ----------------------------
{
  writeFile({ version: 1, tuning: { drain_max_concurrency: 6 } });
  const r = tuning.resolve('drain_max_concurrency', { ...baseEnv(), HEADLESS_DRAIN_MAX_CONCURRENCY: 'banana' });
  ok('(4) unparseable env ⇒ default, NOT the stale file value', r.value === 2 && r.source === 'default');
  const zero = tuning.resolve('drain_max_concurrency', { ...baseEnv(), HEADLESS_DRAIN_MAX_CONCURRENCY: '0' });
  ok('(4) zero is not a usable knob value ⇒ default', zero.value === 2);
}

// ---- (5) unsetValue semantics (max_iterations) -------------------------------------------
{
  clearFile();
  ok('(5) max_iterations unset ⇒ unbounded', tuning.get('drain_max_iterations', baseEnv()) === Number.POSITIVE_INFINITY);
  ok('(5) empty env string still counts as unset',
    tuning.get('drain_max_iterations', { ...baseEnv(), HEADLESS_DRAIN_MAX_ITERATIONS: '' }) === Number.POSITIVE_INFINITY);
  ok('(5) garbage env ⇒ the 50 fallback, not unbounded',
    tuning.get('drain_max_iterations', { ...baseEnv(), HEADLESS_DRAIN_MAX_ITERATIONS: 'lots' }) === 50);
  ok('(5) explicit value honoured',
    tuning.get('drain_max_iterations', { ...baseEnv(), HEADLESS_DRAIN_MAX_ITERATIONS: '12' }) === 12);
  ok('(5) per-tick caps report unset as null (derived at the call site)',
    tuning.get('judge_max_per_tick', baseEnv()) === null && tuning.raw('judge_max_per_tick', baseEnv()) === undefined);
}

// ---- (6) malformed file never throws ------------------------------------------------------
{
  writeFile('{ this is not json');
  let threw = false;
  let value;
  try { value = tuning.get('drain_max_concurrency', baseEnv()); } catch { threw = true; }
  ok('(6) malformed file does not throw', !threw && value === 2);
  ok('(6) the parse error is surfaced, not swallowed', typeof tuning.describe(baseEnv()).file_error === 'string');

  writeFile(['not', 'an', 'object']);
  ok('(6) a non-object body degrades to no file tier', tuning.get('drain_max_concurrency', baseEnv()) === 2);
  clearFile();
  ok('(6) absent file is not an error', tuning.describe(baseEnv()).file_error === null);
}

// ---- (7) path resolution contract ----------------------------------------------------------
{
  ok('(7) explicit ORCH_TUNING_FILE wins', tuning.filePath({ ORCH_TUNING_FILE: FILE }) === FILE);
  ok('(7) ZONOID_SKIP_LIVE alone ⇒ no implicit runtime-dir file', tuning.filePath({ ZONOID_SKIP_LIVE: '1' }) === null);
  ok('(7) explicit path still wins under ZONOID_SKIP_LIVE',
    tuning.filePath({ ZONOID_SKIP_LIVE: '1', ORCH_TUNING_FILE: FILE }) === FILE);
  const implicit = tuning.filePath({ HOME: TMP, USERPROFILE: TMP, APPDATA: TMP });
  ok('(7) otherwise it lands on tuning.json in the runtime dir',
    typeof implicit === 'string' && path.basename(implicit) === 'tuning.json');
}

// ---- (8) write path --------------------------------------------------------------------
{
  clearFile();
  const first = tuning.write({ drain_max_concurrency: 6 }, baseEnv());
  ok('(8) write() persists', first.ok && JSON.parse(fs.readFileSync(FILE, 'utf8')).tuning.drain_max_concurrency === 6);
  const second = tuning.write({ retry_delay_ms: 3000 }, baseEnv());
  ok('(8) write() MERGES rather than replacing',
    second.ok && second.values.drain_max_concurrency === 6 && second.values.retry_delay_ms === 3000);
  ok('(8) string values are coerced on write', tuning.write({ judge_budget: '15' }, baseEnv()).values.judge_budget === 15);

  const cleared = tuning.write({ retry_delay_ms: null }, baseEnv());
  ok('(8) null CLEARS a knob back to default',
    cleared.ok && !('retry_delay_ms' in cleared.values) && tuning.get('retry_delay_ms', baseEnv()) === 5000);

  ok('(8) unknown knob is rejected', tuning.write({ nope: 1 }, baseEnv()).ok === false);
  ok('(8) non-numeric value is rejected', tuning.write({ judge_budget: 'many' }, baseEnv()).ok === false);
  ok('(8) a rejected write does not mutate the file', tuning.get('judge_budget', baseEnv()) === 15);
  ok('(8) validate() is pure and reports why', tuning.validate({ nope: 1 }).error.includes('unknown tuning knob'));
}

// ---- (9) mtime-keyed cache picks up an external edit --------------------------------------
{
  clearFile();
  tuning.write({ drain_max_concurrency: 6 }, baseEnv());
  ok('(9) baseline', tuning.get('drain_max_concurrency', baseEnv()) === 6);
  // Hand-edit the file the way an operator would, WITHOUT calling invalidate().
  const bumped = { version: 1, tuning: { drain_max_concurrency: 8 } };
  fs.writeFileSync(FILE, `${JSON.stringify(bumped)}   `); // extra bytes ⇒ size differs from before
  ok('(9) external edit is picked up with no invalidate()', tuning.get('drain_max_concurrency', baseEnv()) === 8);
}

// ---- (10) headless-drain effectiveConfig ---------------------------------------------------
{
  clearFile();
  const headlessDrain = require('../lib/headless-drain');
  const saved = { ...process.env };
  for (const k of Object.keys(process.env)) if (k.startsWith('HEADLESS_DRAIN_')) delete process.env[k];

  ok('(10) defaults when no file', headlessDrain.effectiveConfig().maxConcurrency === 2);
  tuning.write({ drain_max_concurrency: 6, drain_token_budget: 5000000 }, process.env);
  const fromFile = headlessDrain.effectiveConfig();
  ok('(10) effectiveConfig reads the file tier',
    fromFile.maxConcurrency === 6 && fromFile.tokenBudget === 5000000);
  ok('(10) maxIterations still unbounded by default', fromFile.maxIterations === Number.POSITIVE_INFINITY);

  process.env.HEADLESS_DRAIN_MAX_CONCURRENCY = '3';
  ok('(10) env still overrides the file', headlessDrain.effectiveConfig().maxConcurrency === 3);
  delete process.env.HEADLESS_DRAIN_MAX_CONCURRENCY;

  for (const k of Object.keys(process.env)) if (k.startsWith('HEADLESS_DRAIN_')) delete process.env[k];
  for (const [k, v] of Object.entries(saved)) if (k.startsWith('HEADLESS_DRAIN_')) process.env[k] = v;
}

// ---- (11) headless-spawn workerTimeoutMs ----------------------------------------------------
{
  clearFile();
  const headlessSpawn = require('../lib/headless-spawn');
  const savedEnv = process.env.HEADLESS_SPAWN_TIMEOUT_MS;
  delete process.env.HEADLESS_SPAWN_TIMEOUT_MS;

  ok('(11) default worker timeout is 30min', headlessSpawn.workerTimeoutMs() === 30 * 60 * 1000);
  tuning.write({ spawn_timeout_ms: 3600000 }, process.env);
  ok('(11) file tier drives the worker timeout', headlessSpawn.workerTimeoutMs() === 3600000);
  tuning.write({ spawn_timeout_ms: 1000 }, process.env);
  ok('(11) the 60s floor still applies', headlessSpawn.workerTimeoutMs() === 60000);

  process.env.HEADLESS_SPAWN_TIMEOUT_MS = '900000';
  ok('(11) env still overrides the file', headlessSpawn.workerTimeoutMs() === 900000);
  if (savedEnv === undefined) delete process.env.HEADLESS_SPAWN_TIMEOUT_MS;
  else process.env.HEADLESS_SPAWN_TIMEOUT_MS = savedEnv;
}

// ---- (12) HOT RELOAD of a cadence knob on a LIVE runner ---------------------------------------
{
  clearFile();
  for (const k of ['HEADLESS_DRAIN_CONTINUOUS_DELAY_MS', 'HEADLESS_DRAIN_RETRY_DELAY_MS', 'HEADLESS_DRAIN_IDLE_POLL_MS', 'HEADLESS_DRAIN_INTERVAL_MS']) {
    delete process.env[k];
  }
  const { createHeadlessDrainRunner } = require('../lib/headless-drain-runner');
  // Build the runner BEFORE any tuning exists — this is exactly the daemon's boot order, and the
  // case the old module-load consts got wrong.
  const runner = createHeadlessDrainRunner({ headlessDrain: { _governor: {}, runDueDrains: async () => ({ ran: 0 }) }, state: {} });

  ok('(12) baseline continuous delay', runner._nextDelay({ ran: 1 }) === 15000);
  ok('(12) baseline retry delay', runner._nextDelay({ ran: 0, skipped: 'concurrency_cap' }) === 5000);
  const idleBefore = runner._nextDelay({ ran: 0 });
  ok('(12) baseline idle poll (2min + fixed jitter)', idleBefore >= 120000 && idleBefore < 180000);

  // Retune WITHOUT touching the runner — the daemon-restart-free path.
  tuning.write({ continuous_delay_ms: 5000, retry_delay_ms: 3000, idle_poll_ms: 45000 }, process.env);

  ok('(12) continuous delay retuned on the SAME live runner', runner._nextDelay({ ran: 1 }) === 5000);
  ok('(12) retry delay retuned on the SAME live runner', runner._nextDelay({ ran: 0, skipped: 'backoff' }) === 3000);
  const idleAfter = runner._nextDelay({ ran: 0 });
  ok('(12) idle poll retuned', idleAfter >= 45000 && idleAfter < 105000);
  ok('(12) jitter offset stayed FIXED across the retune', (idleBefore - 120000) === (idleAfter - 45000));
}

// ---- routes: a minimal fake ctx (no port binding) --------------------------------------------
function fakeCtx(extra = {}) {
  const sent = {};
  return {
    sent,
    ctx: {
      send: (res, code, payload) => { sent.code = code; sent.payload = payload; },
      readBody: async () => extra.body || {},
      notifyChange: () => { sent.notified = true; },
      targetOverlay: () => ({ ws: null, ov: null }),
      buildGraph: () => null,
      loops: new Map(),
      ...extra.ctx,
    },
  };
}

// ---- (13) GET /config/tuning ------------------------------------------------------------------
{
  clearFile();
  tuning.write({ drain_max_concurrency: 6 }, process.env);
  const { sent, ctx } = fakeCtx();
  require('../routes/config')(ctx)('/config/tuning', 'GET', {}, {}, new URL('http://x/config/tuning'), null).then(() => {
    ok('(13) GET /config/tuning is handled', sent.code === 200 && sent.payload.ok === true);
    ok('(13) effective values are returned', sent.payload.tuning.drain_max_concurrency === 6);
    ok('(13) per-knob provenance is returned', sent.payload.knobs.drain_max_concurrency.source === 'file');
    ok('(13) the file path is reported', sent.payload.file === FILE);
    ok('(13) nothing needs a restart', Array.isArray(sent.payload.restart_required) && sent.payload.restart_required.length === 0);
    runPostTest();
  });
}

// ---- (14) POST /config/tuning -----------------------------------------------------------------
function runPostTest() {
  const good = fakeCtx({ body: { set: { judge_budget: 25 } } });
  require('../routes/config')(good.ctx)('/config/tuning', 'POST', {}, {}, new URL('http://x/config/tuning'), null)
    .then(() => {
      ok('(14) POST writes and returns 200', good.sent.code === 200 && good.sent.payload.written.judge_budget === 25);
      ok('(14) the write took effect immediately', tuning.get('judge_budget', process.env) === 25);
      ok('(14) no workspace was required', good.sent.payload.ok === true);

      const bare = fakeCtx({ body: { retry_delay_ms: 3000 } });
      return require('../routes/config')(bare.ctx)('/config/tuning', 'POST', {}, {}, new URL('http://x/config/tuning'), null)
        .then(() => ok('(14) a bare knob map (no envelope) is accepted',
          bare.sent.code === 200 && tuning.get('retry_delay_ms', process.env) === 3000));
    })
    .then(() => {
      const bad = fakeCtx({ body: { set: { not_a_knob: 1 } } });
      return require('../routes/config')(bad.ctx)('/config/tuning', 'POST', {}, {}, new URL('http://x/config/tuning'), null)
        .then(() => ok('(14) an unknown knob is a 400, not a silent write',
          bad.sent.code === 400 && bad.sent.payload.ok === false));
    })
    .then(runStatusTest);
}

// ---- (15) GET /status carries the tuning view ---------------------------------------------------
function runStatusTest() {
  const { sent, ctx } = fakeCtx();
  require('../routes/activity')(ctx)('/status', 'GET', {}, {}, new URL('http://x/status'), null)
    .then(() => {
      const t = sent.payload && sent.payload.tuning;
      ok('(15) /status carries a tuning view', !!t);
      ok('(15) it reports the backing file', t && t.file === FILE);
      ok('(15) it reports effective values', t && t.values.judge_budget === 25);
      ok('(15) it reports the winning tier per knob', t && t.sources.judge_budget === 'file');
      finish();
    });
}

function finish() {
  try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* best effort */ }
  console.log('');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}
