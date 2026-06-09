#!/usr/bin/env node
// Plain Node test for the inline metric spec: overlay.setMetricSpec set/clear, save/load
// persistence, back-compat load of an old overlay (no metrics map), and the daemon's
// validateMetricSpec rules (mirrored here for a direct unit assertion — same shape the endpoint
// enforces). No framework; matches the style of test/repo-target.test.js.
// Run: node test/metric-spec.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox BASE so overlays land in a temp dir (BASE is read at require-time).
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-metric-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const overlay = require('../lib/overlay');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Mirror of daemon.js validateMetricSpec (kept in sync) for a direct unit assertion.
function validateMetricSpec(spec) {
  if (typeof spec !== 'object' || Array.isArray(spec)) return 'spec must be an object';
  if (!spec.metric || typeof spec.metric !== 'string') return 'spec.metric (string) required';
  if (spec.direction !== 'min' && spec.direction !== 'max') return 'spec.direction must be "min" or "max"';
  if (!spec.measure_command || typeof spec.measure_command !== 'string') return 'spec.measure_command (string) required';
  if (spec.guardrails != null) {
    if (!Array.isArray(spec.guardrails)) return 'spec.guardrails must be an array';
    for (const gd of spec.guardrails) {
      if (typeof gd !== 'object' || Array.isArray(gd)) return 'each guardrail must be an object';
      if (!gd.metric || typeof gd.metric !== 'string') return 'each guardrail needs a metric (string)';
      if (gd.direction !== 'min' && gd.direction !== 'max') return 'each guardrail needs direction "min" or "max"';
      if (!gd.measure_command || typeof gd.measure_command !== 'string') return 'each guardrail needs a measure_command (string)';
    }
  }
  return null;
}

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-metric-ws-')));
const KEY = 'sess-xyz/3';
const SPEC = {
  metric: 'p95_latency_ms',
  direction: 'min',
  measure_command: 'npm run bench',
  parse: 'last_number',
  target: 120,
  guardrails: [{ metric: 'test_pass', direction: 'max', measure_command: 'npm test', parse: 'last_number' }],
};
try {
  // --- overlay.setMetricSpec set / clear ---
  const ov = overlay.EMPTY();
  ok('metrics map present in EMPTY()', ov.metrics && typeof ov.metrics === 'object');
  overlay.setMetricSpec(ov, KEY, SPEC);
  ok('setMetricSpec records the spec', ov.metrics[KEY] === SPEC);
  ok('spec retains all fields', JSON.stringify(ov.metrics[KEY]) === JSON.stringify(SPEC));
  overlay.setMetricSpec(ov, KEY, null);
  ok('setMetricSpec(null) clears the field', ov.metrics[KEY] === undefined);

  // --- save / load persistence ---
  overlay.setMetricSpec(ov, KEY, SPEC);
  overlay.save(workspace, ov);
  const loaded = overlay.load(workspace);
  ok('spec persists across save/load', JSON.stringify(loaded.metrics[KEY]) === JSON.stringify(SPEC));
  ok('loaded spec keeps guardrails', Array.isArray(loaded.metrics[KEY].guardrails) && loaded.metrics[KEY].guardrails.length === 1);

  // --- back-compat: load an OLD overlay written before the metrics map existed ---
  const old = overlay.EMPTY();
  delete old.metrics;                         // simulate a pre-feature overlay on disk
  old.summaries[KEY] = 'legacy';
  overlay.save(workspace, old);
  const back = overlay.load(workspace);
  ok('old overlay back-fills metrics map', back.metrics && typeof back.metrics === 'object');
  ok('old overlay keeps its other fields', back.summaries[KEY] === 'legacy');
  overlay.setMetricSpec(back, KEY, SPEC);     // setter works on the back-filled map
  ok('setMetricSpec works after back-fill', back.metrics[KEY] === SPEC);

  // --- validation (mirrors the endpoint) ---
  ok('valid spec passes', validateMetricSpec(SPEC) === null);
  ok('minimal valid spec passes', validateMetricSpec({ metric: 'x', direction: 'max', measure_command: 'echo 1' }) === null);
  ok('missing metric rejected', validateMetricSpec({ direction: 'min', measure_command: 'c' }) !== null);
  ok('missing direction rejected', validateMetricSpec({ metric: 'x', measure_command: 'c' }) !== null);
  ok('bad direction rejected', validateMetricSpec({ metric: 'x', direction: 'lower', measure_command: 'c' }) !== null);
  ok('missing measure_command rejected', validateMetricSpec({ metric: 'x', direction: 'min' }) !== null);
  ok('non-object spec rejected', validateMetricSpec([1, 2]) !== null);
  ok('non-array guardrails rejected', validateMetricSpec({ metric: 'x', direction: 'min', measure_command: 'c', guardrails: {} }) !== null);
  ok('bad guardrail entry rejected', validateMetricSpec({ metric: 'x', direction: 'min', measure_command: 'c', guardrails: [{ metric: 'g' }] }) !== null);
} finally {
  for (const d of [workspace, SANDBOX]) fs.rmSync(d, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
