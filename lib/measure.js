// Run a task's inline metric spec (lib/overlay metrics[key]) in a worktree and parse the number(s).
// The MEASURE half of the metric-driven loop: given an attempt's worktree (from the git layer) and
// the task's metric spec (from the inline-metric layer), execute measure_command, extract a number,
// and also run each guardrail. Pure-ish: no overlay/daemon coupling — callers store the result.
//
// Shells out via execSync with a bounded timeout. A non-zero exit surfaces as a thrown error (the
// caller turns it into an endpoint error). `parse` is free-form: the sentinel "last_number" (last
// numeric token on stdout) or a regex string with ONE capture group whose group 1 is the number.
'use strict';
const { execSync } = require('child_process');

const DEFAULT_TIMEOUT_MS = 120000; // bounded so a runaway measure command can't hang the daemon

// Extract a number from stdout per `parse`. Default (absent/"last_number") = last numeric token.
// Otherwise `parse` is a regex string with one capture group; group 1 is parsed as a float.
// Throws a clear error if no number is found (so a mis-specified measure surfaces, not a silent NaN).
function parseNumber(stdout, parse) {
  const text = String(stdout == null ? '' : stdout);
  if (!parse || parse === 'last_number') {
    // Last signed/decimal/exponent numeric token anywhere in the output.
    const matches = text.match(/-?\d+(?:\.\d+)?(?:[eE][-+]?\d+)?/g);
    if (!matches || !matches.length) throw new Error(`parseNumber: no number on stdout (parse="last_number")`);
    return Number(matches[matches.length - 1]);
  }
  let re;
  try { re = new RegExp(parse); }
  catch (e) { throw new Error(`parseNumber: invalid regex ${JSON.stringify(parse)}: ${e.message}`); }
  const m = text.match(re);
  if (!m || m[1] == null) throw new Error(`parseNumber: regex ${JSON.stringify(parse)} matched no capture group on stdout`);
  const n = Number(m[1]);
  if (Number.isNaN(n)) throw new Error(`parseNumber: captured ${JSON.stringify(m[1])} is not a number`);
  return n;
}

// Run a single measure command in cwd and parse its stdout. Throws on non-zero exit (the error
// carries the command's stderr/stdout so the caller can report why it failed).
function measureOne(cwd, command, parse, timeout) {
  let stdout;
  try {
    stdout = execSync(command, { cwd, encoding: 'utf8', timeout: timeout || DEFAULT_TIMEOUT_MS, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
  } catch (e) {
    const detail = (e.stderr || e.stdout || e.message || '').toString().trim().slice(0, 500);
    throw new Error(`measure command failed (${command}): ${detail}`);
  }
  return parseNumber(stdout, parse);
}

// Run spec.measure_command (+ each spec.guardrails[] command) in worktreePath.
// -> { value, guardrails: { <guardrail.metric>: value, ... } }. guardrails is {} when none.
function runMeasure(worktreePath, spec, opts = {}) {
  if (!spec || typeof spec !== 'object') throw new Error('runMeasure: a metric spec is required');
  if (!spec.measure_command) throw new Error('runMeasure: spec.measure_command is required');
  const timeout = opts.timeout || DEFAULT_TIMEOUT_MS;
  const value = measureOne(worktreePath, spec.measure_command, spec.parse, timeout);
  const guardrails = {};
  for (const gd of Array.isArray(spec.guardrails) ? spec.guardrails : []) {
    guardrails[gd.metric] = measureOne(worktreePath, gd.measure_command, gd.parse, timeout);
  }
  return { value, guardrails };
}

// Did a measured guardrail value REGRESS vs. baseline, given its direction?
//   direction "max" (higher-is-better) regresses when measured < baseline.
//   direction "min" (lower-is-better)  regresses when measured > baseline.
function regressed(direction, baseline, measured) {
  if (typeof baseline !== 'number' || typeof measured !== 'number') return false;
  return direction === 'min' ? measured > baseline : measured < baseline;
}

// Given the spec's guardrails plus baseline + measured guardrail maps, return the list of guardrail
// metrics that REGRESSED — each { metric, direction, baseline, measured }. Empty ⇒ none regressed.
// A guardrail with no baseline value is skipped (nothing to compare against).
function evalGuardrails(spec, baselineGuardrails, measuredGuardrails) {
  const out = [];
  const base = baselineGuardrails || {};
  const meas = measuredGuardrails || {};
  for (const gd of (spec && Array.isArray(spec.guardrails)) ? spec.guardrails : []) {
    const b = base[gd.metric];
    const m = meas[gd.metric];
    if (typeof b !== 'number' || typeof m !== 'number') continue;
    if (regressed(gd.direction, b, m)) out.push({ metric: gd.metric, direction: gd.direction, baseline: b, measured: m });
  }
  return out;
}

module.exports = { parseNumber, runMeasure, regressed, evalGuardrails, DEFAULT_TIMEOUT_MS };
