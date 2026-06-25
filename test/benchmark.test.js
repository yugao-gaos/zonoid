#!/usr/bin/env node
// Plain Node test for the researched competitor/industry-average benchmark: overlay.setBenchmark
// set/clear, save/load persistence, back-compat load of an old overlay (no benchmarks map), and the
// daemon's validateBenchmark rules (mirrored here for a direct unit assertion — same shape the
// endpoint enforces). No framework; matches the style of test/metric-spec.test.js.
// Run: node test/benchmark.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox BASE so overlays land in a temp dir (BASE is read at require-time).
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bench-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const overlay = require('../lib/overlay');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Mirror of daemon.js validateBenchmark (kept in sync) for a direct unit assertion.
function validateBenchmark(b) {
  if (typeof b !== 'object' || Array.isArray(b)) return 'benchmark must be an object';
  if (!b.metric || typeof b.metric !== 'string') return 'benchmark.metric (string) required';
  if (typeof b.value !== 'number' || Number.isNaN(b.value)) return 'benchmark.value (number) required';
  if (!b.source || typeof b.source !== 'string') return 'benchmark.source (string) required';
  if (b.confidence != null && b.confidence !== 'low' && b.confidence !== 'med' && b.confidence !== 'high') return 'benchmark.confidence must be "low", "med", or "high"';
  return null;
}

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-bench-ws-')));
const KEY = 'sess-xyz/4';
const BENCH = {
  metric: 'p95_latency_ms',
  value: 95,
  unit: 'ms',
  source: 'https://example.com/industry-report-2026',
  note: 'industry average across 5 vendors',
  confidence: 'med',
  researched_at: '2026-06-09T00:00:00Z',
};
try {
  // --- overlay.setBenchmark set / clear ---
  const ov = overlay.EMPTY();
  ok('benchmarks map present in EMPTY()', ov.benchmarks && typeof ov.benchmarks === 'object');
  overlay.setBenchmark(ov, KEY, BENCH);
  ok('setBenchmark records the record', ov.benchmarks[KEY] === BENCH);
  ok('record retains all fields', JSON.stringify(ov.benchmarks[KEY]) === JSON.stringify(BENCH));
  overlay.setBenchmark(ov, KEY, null);
  ok('setBenchmark(null) clears the field', ov.benchmarks[KEY] === undefined);

  // --- save / load persistence ---
  overlay.setBenchmark(ov, KEY, BENCH);
  overlay.save(workspace, ov);
  const loaded = overlay.load(workspace);
  ok('record persists across save/load', JSON.stringify(loaded.benchmarks[KEY]) === JSON.stringify(BENCH));
  ok('loaded record keeps confidence', loaded.benchmarks[KEY].confidence === 'med');

  // --- back-compat: load an OLD overlay written before the benchmarks map existed ---
  const old = overlay.EMPTY();
  delete old.benchmarks;                      // simulate a pre-feature overlay on disk
  old.summaries[KEY] = 'legacy';
  overlay.save(workspace, old);
  const back = overlay.load(workspace);
  ok('old overlay back-fills benchmarks map', back.benchmarks && typeof back.benchmarks === 'object');
  ok('old overlay keeps its other fields', back.summaries[KEY] === 'legacy');
  overlay.setBenchmark(back, KEY, BENCH);     // setter works on the back-filled map
  ok('setBenchmark works after back-fill', back.benchmarks[KEY] === BENCH);

  // --- validation (mirrors the endpoint) ---
  ok('valid record passes', validateBenchmark(BENCH) === null);
  ok('minimal valid record passes', validateBenchmark({ metric: 'x', value: 1, source: 's' }) === null);
  ok('value 0 is valid', validateBenchmark({ metric: 'x', value: 0, source: 's' }) === null);
  ok('missing metric rejected', validateBenchmark({ value: 1, source: 's' }) !== null);
  ok('missing value rejected', validateBenchmark({ metric: 'x', source: 's' }) !== null);
  ok('non-number value rejected', validateBenchmark({ metric: 'x', value: '1', source: 's' }) !== null);
  ok('NaN value rejected', validateBenchmark({ metric: 'x', value: NaN, source: 's' }) !== null);
  ok('missing source rejected', validateBenchmark({ metric: 'x', value: 1 }) !== null);
  ok('non-object record rejected', validateBenchmark([1, 2]) !== null);
  ok('bad confidence rejected', validateBenchmark({ metric: 'x', value: 1, source: 's', confidence: 'high-ish' }) !== null);
} finally {
  for (const d of [workspace, SANDBOX]) fs.rmSync(d, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
