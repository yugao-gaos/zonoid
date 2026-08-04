'use strict';
/**
 * lib/tuning.js — PERSISTED daemon tuning knobs (env > file > default).
 *
 * Problem this fixes: every drain/worker cadence knob was env-only, so tuning the daemon meant
 * exporting HEADLESS_DRAIN_* and RESTARTING it — and the values died on the next reboot. Three
 * manual restarts in one evening (code load, log capture, cadence tuning) traced back to that.
 *
 * The knobs now resolve through one table with a three-tier precedence:
 *
 *   env      — process.env still wins, so an operator can always override a bad file for one boot.
 *   file     — <runtime dir>/tuning.json, the durable per-machine config (survives reboot).
 *   default  — the compiled-in conservative default.
 *
 * HOT RELOAD. Nothing here is captured at module load: every consumer calls get()/raw() per use,
 * and the file parse is cached on (path, mtime, size) so a hand-edit of tuning.json is picked up on
 * the next resolve with no restart. POST /config/tuning writes the file and calls invalidate() so
 * the change lands on the very next pump. Consumers that previously froze a knob into a
 * module-level const (lib/headless-drain-runner.js) were converted to getters for exactly this.
 *
 * FILE SHAPE. Either the versioned envelope or a bare flat map is accepted:
 *   { "version": 1, "tuning": { "drain_max_concurrency": 6 } }
 *   { "drain_max_concurrency": 6 }
 * write() always emits the envelope.
 *
 * NEVER THROWS. A missing / unreadable / malformed file degrades to "no file tier" and records the
 * error for surfacing on /status — a daemon that will not boot because its optional tuning file has
 * a stray comma is strictly worse than one running on defaults.
 *
 * Env overrides:
 *   ORCH_TUNING_FILE  — explicit tuning file path (also re-enables under ZONOID_SKIP_LIVE)
 *   ZONOID_SKIP_LIVE  — test guard: no implicit default into the real runtime dir (same contract as
 *                       lib/daemon-log.js resolvePath() and lib/activity.js logFile()).
 */
const fs = require('fs');
const path = require('path');

/**
 * The knob table. One row per tunable; `env` is the historical variable name (kept verbatim so
 * existing muscle memory and docs keep working), `default` is the compiled-in value.
 *
 *   envAlso     — additional env names checked after `env` (legacy aliases).
 *   unsetValue  — value when NO tier supplies a raw value at all. Only set where "unset" means
 *                 something other than `default` (e.g. unbounded). `default` then covers the
 *                 "a tier supplied a raw value but it was garbage" case, matching the historical
 *                 `Number(env) || FALLBACK` behaviour exactly.
 */
const KNOBS = {
  drain_max_concurrency: {
    env: 'HEADLESS_DRAIN_MAX_CONCURRENCY',
    default: 2,
    doc: 'max simultaneously running headless drain child processes (fork-bomb guard)',
  },
  drain_token_budget: {
    env: 'HEADLESS_DRAIN_TOKEN_BUDGET',
    default: 20000000,
    // UNSET ⇒ UNBOUNDED, on purpose. This gate reads _governor.tokensUsed, which nothing
    // incremented until the autonomy meter landed — so a 200000 default that had never once fired
    // would have become a live cap the first metered child blows through (one agentic worker run
    // routinely reports ~1M input+output). Worse, a PER-BOOT counter never resets while the daemon
    // runs, so any finite default silently halts every headless drain for the rest of the boot.
    // The default autonomy ceiling is `autonomy_daily_token_budget` (per workspace, per calendar
    // day, resets at midnight — lib/autonomy-budget.js); this knob stays as an explicit opt-in
    // per-boot backstop for operators who want one.
    unsetValue: Number.POSITIVE_INFINITY,
    doc: 'max tokens the headless drain pool may spend per daemon boot (unset = unbounded; the '
      + 'default ceiling is autonomy_daily_token_budget, which resets daily)',
  },
  drain_max_iterations: {
    env: 'HEADLESS_DRAIN_MAX_ITERATIONS',
    default: 50,
    unsetValue: Number.POSITIVE_INFINITY, // unset ⇒ unbounded; the explicit cap is opt-in
    doc: 'max individual drain runs per daemon boot (unset = unbounded)',
  },
  drain_timeout_ms: {
    env: 'HEADLESS_DRAIN_TIMEOUT_MS',
    default: 5 * 60 * 1000,
    doc: 'per-drain-run wall-clock timeout before SIGKILL',
  },
  spawn_timeout_ms: {
    env: 'HEADLESS_SPAWN_TIMEOUT_MS',
    default: 30 * 60 * 1000,
    doc: 'per-headless-worker wall-clock timeout before SIGKILL',
  },
  continuous_delay_ms: {
    env: 'HEADLESS_DRAIN_CONTINUOUS_DELAY_MS',
    default: 15000,
    doc: 'pump delay after a tick that DID work (backlog cadence)',
  },
  idle_poll_ms: {
    env: 'HEADLESS_DRAIN_IDLE_POLL_MS',
    envAlso: ['HEADLESS_DRAIN_INTERVAL_MS'],
    default: 2 * 60 * 1000,
    doc: 'pump delay after an idle tick (jitter is added on top, per runner)',
  },
  retry_delay_ms: {
    env: 'HEADLESS_DRAIN_RETRY_DELAY_MS',
    default: 5000,
    doc: 'pump delay after a capped/backed-off tick',
  },
  judge_budget: {
    env: 'HEADLESS_DRAIN_JUDGE_BUDGET',
    default: 20,
    doc: 'items one judge drain run may adjudicate',
  },
  // The two per-tick caps are DERIVED knobs: when no tier sets them the call site computes the
  // fallback from the live concurrency cap (judge ⇒ unbounded, learner ⇒ min(1, maxConcurrency)),
  // so they resolve to null here and the consumers read raw() to keep that distinction.
  judge_max_per_tick: {
    env: 'HEADLESS_DRAIN_MAX_PER_TICK',
    default: null,
    unsetValue: null,
    derived: true,
    doc: 'max judge spawns started per pump (unset = unbounded)',
  },
  learner_max_per_tick: {
    env: 'HEADLESS_DRAIN_LEARNER_MAX_PER_TICK',
    default: null,
    unsetValue: null,
    derived: true,
    doc: 'max learner spawns started per pump (unset = min(1, drain_max_concurrency))',
  },
};

const KNOB_NAMES = Object.keys(KNOBS);

// ---- file tier -----------------------------------------------------------------------

function isTruthyEnv(v) {
  return v != null && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';
}

/** Resolve where the tuning file lives, or null when there is no file tier on this host. */
function filePath(env = process.env) {
  if (env.ORCH_TUNING_FILE) return path.resolve(env.ORCH_TUNING_FILE);
  // Test guard: a suite that forgot to point ORCH_TUNING_FILE at a temp dir must not inherit the
  // developer's real machine tuning (it would make drain tests non-deterministic).
  if (isTruthyEnv(env.ZONOID_SKIP_LIVE)) return null;
  try {
    return path.join(require('./runtime-paths').resolveDataDir(env), 'tuning.json');
  } catch {
    return null;
  }
}

// Parse cache keyed on (path, mtimeMs, size) so a hand-edit of the file is picked up without a
// restart while a hot pump loop does not re-read + re-parse it on every single resolve.
let _cache = null;

/** Drop the parse cache. Call after writing the file so the next resolve sees the new values. */
function invalidate() {
  _cache = null;
}

/**
 * Read the file tier. Returns { path, values, error } — `values` is always a plain object (empty
 * when there is no usable file) and `error` is a string only when a file exists but could not be
 * read or parsed. Never throws.
 */
function loadFile(env = process.env) {
  const file = filePath(env);
  if (!file) return { path: null, values: {}, error: null };

  let stamp;
  try {
    const st = fs.statSync(file);
    stamp = `${st.mtimeMs}:${st.size}`;
  } catch {
    // Absent file is the normal case (no persisted tuning yet) — not an error.
    _cache = { file, stamp: 'absent', result: { path: file, values: {}, error: null } };
    return _cache.result;
  }

  if (_cache && _cache.file === file && _cache.stamp === stamp) return _cache.result;

  let result;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    const body = (parsed && typeof parsed.tuning === 'object' && parsed.tuning) ? parsed.tuning : parsed;
    const values = (body && typeof body === 'object' && !Array.isArray(body)) ? body : {};
    result = { path: file, values, error: null };
  } catch (e) {
    result = { path: file, values: {}, error: e && e.message ? e.message : String(e) };
  }
  _cache = { file, stamp, result };
  return result;
}

// ---- resolution ----------------------------------------------------------------------

/** A raw tier value counts as "present" unless it is absent, null, or an empty string. */
function present(v) {
  return v !== undefined && v !== null && v !== '';
}

/**
 * Coerce a raw value to the positive finite number the knobs all expect, or undefined when it is
 * not usable. Mirrors the historical `Number(x) || FALLBACK` guard: 0 and NaN both mean "fall
 * through to the next tier", because no knob here has a meaningful zero (a zero concurrency cap or
 * zero token budget would silently disable the drain pool).
 */
function coerce(v) {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : undefined;
}

function knobOrThrow(name) {
  const spec = KNOBS[name];
  if (!spec) throw new Error(`unknown tuning knob '${name}' (known: ${KNOB_NAMES.join(', ')})`);
  return spec;
}

/** The env names this knob answers to, primary first. */
function envNames(spec) {
  return [spec.env, ...(spec.envAlso || [])];
}

/**
 * Highest-precedence RAW value for a knob (env, then file), or undefined when no tier supplies one.
 * Exposed because two call sites need the historical "was it set at all?" distinction rather than a
 * coerced number (unset ⇒ unbounded, set-but-garbage ⇒ a runtime-derived fallback).
 */
function raw(name, env = process.env) {
  const spec = knobOrThrow(name);
  for (const key of envNames(spec)) {
    if (present(env[key])) return env[key];
  }
  const fileValue = loadFile(env).values[name];
  return present(fileValue) ? fileValue : undefined;
}

/** Resolve a knob to { value, source } where source is 'env' | 'file' | 'default'. */
function resolve(name, env = process.env) {
  const spec = knobOrThrow(name);

  let tier = null;
  let rawValue;
  for (const key of envNames(spec)) {
    if (present(env[key])) { tier = 'env'; rawValue = env[key]; break; }
  }
  if (tier === null) {
    const fileValue = loadFile(env).values[name];
    if (present(fileValue)) { tier = 'file'; rawValue = fileValue; }
  }

  if (tier === null) {
    return { value: spec.unsetValue !== undefined ? spec.unsetValue : spec.default, source: 'default' };
  }
  const n = coerce(rawValue);
  // A tier supplied something unusable: fall back to the compiled-in default, NOT to the lower
  // tier — a garbage env var must not silently resurrect a stale file value.
  if (n === undefined) return { value: spec.default, source: 'default' };
  return { value: n, source: tier };
}

/** Resolved value for one knob. */
function get(name, env = process.env) {
  return resolve(name, env).value;
}

/** Which tier a knob's live value came from ('env' | 'file' | 'default'). */
function sourceOf(name, env = process.env) {
  return resolve(name, env).source;
}

/** Flat { knob: value } map of every resolved knob — the compact view for logs and /status. */
function effective(env = process.env) {
  const out = {};
  for (const name of KNOB_NAMES) out[name] = get(name, env);
  return out;
}

/**
 * Full explainer: per-knob value + source + the raw value each tier offered, plus the file's path
 * and parse error. This is what GET /config/tuning returns and what makes "why is concurrency 2
 * when I set it to 6" answerable without a restart.
 */
function describe(env = process.env) {
  const file = loadFile(env);
  const knobs = {};
  for (const name of KNOB_NAMES) {
    const spec = KNOBS[name];
    const { value, source } = resolve(name, env);
    const envName = envNames(spec).find((k) => present(env[k])) || null;
    knobs[name] = {
      value,
      source,
      env_var: spec.env,
      env_value: envName ? env[envName] : null,
      file_value: present(file.values[name]) ? file.values[name] : null,
      default: spec.unsetValue !== undefined ? spec.unsetValue : spec.default,
      doc: spec.doc,
    };
  }
  return {
    file: file.path,
    file_error: file.error,
    // Every knob re-resolves per use, so a file or runtime change lands on the next pump. Reported
    // explicitly so the dashboard/README claim "no restart needed" is checkable, not folklore.
    restart_required: [],
    knobs,
  };
}

// ---- write path ----------------------------------------------------------------------

/**
 * Validate a { knob: value } patch. Unknown knobs and non-positive/non-numeric values are rejected
 * (null is allowed — it CLEARS the knob back to env/default). Returns { ok, patch } or { ok:false,
 * error }. Pure: callers can validate without touching disk.
 */
function validate(patch) {
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) {
    return { ok: false, error: 'tuning patch must be an object of { knob: value }' };
  }
  const clean = {};
  for (const [name, value] of Object.entries(patch)) {
    if (!KNOBS[name]) {
      return { ok: false, error: `unknown tuning knob '${name}' (known: ${KNOB_NAMES.join(', ')})` };
    }
    if (value === null) { clean[name] = null; continue; }
    const n = coerce(value);
    if (n === undefined) {
      return { ok: false, error: `tuning knob '${name}' must be a positive number (got ${JSON.stringify(value)})` };
    }
    clean[name] = n;
  }
  return { ok: true, patch: clean };
}

/**
 * Merge a validated patch into the tuning file and persist it. A null value DELETES the key (the
 * knob reverts to env/default). Returns { ok, path, values } or { ok:false, error }. Invalidates the
 * parse cache on success so the very next resolve — i.e. the next pump — sees the new values.
 */
function write(patch, env = process.env) {
  const valid = validate(patch);
  if (!valid.ok) return valid;

  const file = filePath(env);
  if (!file) {
    return { ok: false, error: 'no tuning file path resolved (set ORCH_TUNING_FILE)' };
  }

  const current = { ...loadFile(env).values };
  for (const [name, value] of Object.entries(valid.patch)) {
    if (value === null) delete current[name];
    else current[name] = value;
  }

  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify({ version: 1, tuning: current }, null, 2)}\n`);
  } catch (e) {
    return { ok: false, error: `failed to write ${file}: ${e && e.message ? e.message : String(e)}` };
  }
  invalidate();
  return { ok: true, path: file, values: current };
}

/** One-line boot/log summary: only the knobs NOT on their default, plus where the file lives. */
function summaryLine(env = process.env) {
  const file = loadFile(env);
  const parts = [];
  for (const name of KNOB_NAMES) {
    const { value, source } = resolve(name, env);
    if (source === 'default') continue;
    parts.push(`${name}=${value}(${source})`);
  }
  const where = file.path ? file.path : 'none';
  const err = file.error ? ` tuning_file_error=${JSON.stringify(file.error)}` : '';
  return `tuning_file=${where}${err} ${parts.length ? parts.join(' ') : 'all_defaults'}`;
}

module.exports = {
  KNOBS,
  KNOB_NAMES,
  filePath,
  loadFile,
  invalidate,
  raw,
  resolve,
  get,
  sourceOf,
  effective,
  describe,
  validate,
  write,
  summaryLine,
};
