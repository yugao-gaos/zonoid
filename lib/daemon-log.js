'use strict';
/**
 * Always-on daemon file log: tees every process.stdout/stderr write into a size-rotated
 * file so a daemon launched windowless (no console, no shell redirection) still leaves a
 * post-mortem trail. Observed failure mode this fixes: the daemon ran detached with stdout
 * lost, and errors were invisible until a manual restart with shell redirection.
 *
 * Design constraints:
 *   - Dependency-free (node builtins only) and required FIRST in daemon.js, before any other
 *     require can log — so even module-load-time output is captured.
 *   - Never throws into the daemon: every filesystem touch is wrapped; a full disk or a
 *     read-only dir degrades the ARCHIVE, never the live stream (the original write always
 *     proceeds).
 *   - Size-based rotation: 10MB per generation x 3 files total (daemon.log, .1, .2). The
 *     oldest generation is discarded on rotation.
 *   - Line-stamped: each log LINE gets an ISO timestamp + stream tag prefix. Partial writes
 *     (no trailing newline) are tracked per stream so a line split across write() calls is
 *     stamped exactly once.
 *
 * Env overrides:
 *   ORCH_DAEMON_LOG             — explicit log file path (also re-enables under ZONOID_SKIP_LIVE)
 *   ORCH_DAEMON_LOG_MAX_BYTES   — rotation threshold per generation (default 10MB)
 *   ORCH_DAEMON_LOG_GENERATIONS — total file count incl. live (default 3)
 *   ORCH_DAEMON_LOG_OFF=1       — disable the tee entirely
 *   ZONOID_SKIP_LIVE            — test guard: no implicit default into the real runtime dir
 *                                 (same contract as lib/activity.js logFile()).
 */
const fs = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 10 * 1024 * 1024; // 10MB per generation
const DEFAULT_GENERATIONS = 3;              // live file + 2 rotated

// Module state. The tee is process-global by nature (it wraps the process streams), so the
// state is module-singleton on purpose.
let _installed = false;
let _path = null;
// Per-stream "are we at the start of a line" flag so timestamps land exactly at line starts
// even when one logical line arrives across several write() calls.
const _atLineStart = { out: true, err: true };

function isTruthyEnv(v) {
  return v != null && v !== '' && v !== '0' && String(v).toLowerCase() !== 'false';
}

/** Resolve where the daemon log should live, or null when the tee is disabled. */
function resolvePath(env = process.env) {
  if (isTruthyEnv(env.ORCH_DAEMON_LOG_OFF)) return null;
  if (env.ORCH_DAEMON_LOG) return path.resolve(env.ORCH_DAEMON_LOG);
  // Test guard (same as lib/activity.js): a suite that forgot to redirect must not append to
  // the user's real runtime dir. An explicit ORCH_DAEMON_LOG above still wins.
  if (env.ZONOID_SKIP_LIVE) return null;
  try {
    return path.join(require('./runtime-paths').resolveDataDir(env), 'daemon.log');
  } catch {
    return null;
  }
}

function maxBytes(env = process.env) {
  const n = Number(env.ORCH_DAEMON_LOG_MAX_BYTES);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : DEFAULT_MAX_BYTES;
}

function generations(env = process.env) {
  const n = Number(env.ORCH_DAEMON_LOG_GENERATIONS);
  return Number.isFinite(n) && n >= 1 ? Math.floor(n) : DEFAULT_GENERATIONS;
}

/**
 * Shift generations: file -> file.1 -> file.2 -> (discarded). `gens` is the TOTAL file count
 * including the live file; every step is individually best-effort so one locked generation
 * (Windows AV scan, another reader) cannot wedge the whole rotation.
 */
function rotate(file, gens) {
  try { fs.unlinkSync(`${file}.${gens - 1}`); } catch { /* oldest generation absent */ }
  for (let i = gens - 1; i >= 2; i--) {
    try { fs.renameSync(`${file}.${i - 1}`, `${file}.${i}`); } catch { /* generation absent */ }
  }
  try { fs.renameSync(file, `${file}.1`); } catch { /* live file absent or locked — keep appending */ }
}

/** Prefix each line start in `text` with an ISO timestamp + stream tag, tracking split lines. */
function stampChunk(streamKey, text) {
  const tag = streamKey === 'err' ? 'ERR' : 'OUT';
  const prefix = `${new Date().toISOString()} [${tag}] `;
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (_atLineStart[streamKey]) { out += prefix; _atLineStart[streamKey] = false; }
    const nl = text.indexOf('\n', i);
    if (nl === -1) { out += text.slice(i); break; }
    out += text.slice(i, nl + 1);
    _atLineStart[streamKey] = true;
    i = nl + 1;
  }
  return out;
}

/** Append one stream chunk to the log, rotating first when the live file is at the cap. */
function tee(streamKey, chunk) {
  const file = _path;
  if (!file) return;
  try {
    const text = typeof chunk === 'string' ? chunk : Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk);
    if (!text) return;
    let size = 0;
    try { size = fs.statSync(file).size; } catch { size = 0; }
    if (size >= maxBytes()) {
      rotate(file, generations());
      _atLineStart[streamKey] = true; // new generation starts at a line boundary
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, stampChunk(streamKey, text));
  } catch { /* the archive is advisory — never break the live stream */ }
}

/**
 * Point the tee at a log file WITHOUT wrapping the process streams. install() calls this;
 * tests use it directly so they can drive tee() without hijacking the test runner's stdout.
 */
function configure(env = process.env) {
  _path = resolvePath(env);
  _atLineStart.out = true;
  _atLineStart.err = true;
  return _path;
}

/**
 * Wrap process.stdout.write / process.stderr.write so every chunk is ALSO appended to the
 * rotating log file. Idempotent; the original write always runs (and its return value /
 * callback contract is preserved), so backpressure semantics are untouched.
 */
function install(env = process.env) {
  if (_installed) return { installed: true, path: _path };
  configure(env);
  _installed = true;
  if (!_path) return { installed: false, path: null };
  for (const [key, stream] of [['out', process.stdout], ['err', process.stderr]]) {
    const orig = stream.write.bind(stream);
    stream.write = function write(chunk, encoding, cb) {
      try { tee(key, chunk); } catch { /* never break the live stream */ }
      return orig(chunk, encoding, cb);
    };
  }
  return { installed: true, path: _path };
}

/** The ACTIVE tee target (null when the tee is disabled or install() has not run). */
function logPath() {
  return _installed ? _path : null;
}

/** Test seam: forget install/configure state (cannot un-wrap already-wrapped streams). */
function _resetForTests() {
  _installed = false;
  _path = null;
  _atLineStart.out = true;
  _atLineStart.err = true;
}

module.exports = {
  install,
  configure,
  logPath,
  resolvePath,
  DEFAULT_MAX_BYTES,
  DEFAULT_GENERATIONS,
  // test seams
  _tee: tee,
  _rotate: rotate,
  _maxBytes: maxBytes,
  _generations: generations,
  _resetForTests,
};
