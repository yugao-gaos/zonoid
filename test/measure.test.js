#!/usr/bin/env node
// Plain Node test for the measure node: lib/measure.parseNumber (both parse forms + failure),
// runMeasure against FAKE measure commands (echo), evalGuardrails regression detection, and the
// overlay.setMeasurement set/clear + save/load persistence + back-compat (old overlay, no map).
// No framework; matches the style of test/metric-spec.test.js. Run: node test/measure.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

// Sandbox BASE so overlays land in a temp dir (BASE is read at require-time).
const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-measure-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const measure = require('../lib/measure');
const overlay = require('../lib/overlay');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const workspace = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-measure-ws-')));
const KEY = 'sess-xyz/3';
try {
  // --- parseNumber: last_number sentinel ---
  ok('last_number: picks the last numeric token', measure.parseNumber('p50 12 p95 118', 'last_number') === 118);
  ok('last_number: default when parse absent', measure.parseNumber('latency is 42 ms') === 42);
  ok('last_number: handles decimals', measure.parseNumber('score 0.5 then 3.14') === 3.14);
  ok('last_number: handles negatives', measure.parseNumber('delta -7') === -7);

  // --- parseNumber: regex-with-one-capture-group ---
  ok('regex: captures the group', measure.parseNumber('p95=118ms\np99=240ms', 'p95=(\\d+)') === 118);
  ok('regex: float capture', measure.parseNumber('coverage: 87.5%', 'coverage:\\s*([\\d.]+)') === 87.5);

  // --- parseNumber: failures throw clearly ---
  let threw = false; try { measure.parseNumber('no numbers here', 'last_number'); } catch { threw = true; }
  ok('last_number: throws when no number', threw);
  threw = false; try { measure.parseNumber('nope', 'p95=(\\d+)'); } catch { threw = true; }
  ok('regex: throws when no match', threw);
  threw = false; try { measure.parseNumber('x', '([invalid'); } catch { threw = true; }
  ok('regex: throws on invalid pattern', threw);

  // --- runMeasure against FAKE measure commands (echo) ---
  const spec = {
    metric: 'p95_latency_ms', direction: 'min', measure_command: 'echo 42', parse: 'last_number',
    guardrails: [{ metric: 'test_pass', direction: 'max', measure_command: 'echo 1', parse: 'last_number' }],
  };
  const r = measure.runMeasure(workspace, spec);
  ok('runMeasure returns the parsed value', r.value === 42);
  ok('runMeasure runs guardrails', r.guardrails.test_pass === 1);

  const r2 = measure.runMeasure(workspace, { metric: 'm', direction: 'max', measure_command: 'echo 7' });
  ok('runMeasure: no guardrails -> {}', r2.value === 7 && Object.keys(r2.guardrails).length === 0);

  threw = false; try { measure.runMeasure(workspace, { metric: 'm', direction: 'min', measure_command: 'exit 3' }); } catch { threw = true; }
  ok('runMeasure: non-zero exit throws', threw);

  // --- regressed + evalGuardrails ---
  ok('regressed: min worse when measured > baseline', measure.regressed('min', 100, 120) === true);
  ok('regressed: min ok when measured < baseline', measure.regressed('min', 100, 80) === false);
  ok('regressed: max worse when measured < baseline', measure.regressed('max', 1, 0) === true);
  ok('regressed: max ok when measured >= baseline', measure.regressed('max', 1, 1) === false);

  const gspec = { guardrails: [
    { metric: 'test_pass', direction: 'max', measure_command: 'x' },
    { metric: 'bundle_kb', direction: 'min', measure_command: 'x' },
  ] };
  const regs = measure.evalGuardrails(gspec, { test_pass: 1, bundle_kb: 200 }, { test_pass: 0, bundle_kb: 180 });
  ok('evalGuardrails: flags the regressed guardrail only', regs.length === 1 && regs[0].metric === 'test_pass');
  ok('evalGuardrails: carries baseline+measured', regs[0].baseline === 1 && regs[0].measured === 0);
  const none = measure.evalGuardrails(gspec, { test_pass: 1, bundle_kb: 200 }, { test_pass: 1, bundle_kb: 200 });
  ok('evalGuardrails: empty when nothing regressed', none.length === 0);
  ok('evalGuardrails: skips guardrails with no baseline', measure.evalGuardrails(gspec, {}, { test_pass: 0 }).length === 0);

  // --- overlay.setMeasurement set / merge / clear ---
  const ov = overlay.EMPTY();
  ok('measurements map present in EMPTY()', ov.measurements && typeof ov.measurements === 'object');
  overlay.setMeasurement(ov, KEY, { value: 42, guardrails: { test_pass: 1 } });
  ok('setMeasurement records the attempt value', ov.measurements[KEY].value === 42);
  overlay.setMeasurement(ov, KEY, { baseline: { value: 130 } });
  ok('setMeasurement merges baseline without clobbering attempt', ov.measurements[KEY].value === 42 && ov.measurements[KEY].baseline.value === 130);
  overlay.setMeasurement(ov, KEY, null);
  ok('setMeasurement(null) clears the record', ov.measurements[KEY] === undefined);

  // --- save / load persistence ---
  overlay.setMeasurement(ov, KEY, { value: 42, baseline: { value: 130 } });
  overlay.save(workspace, ov);
  const loaded = overlay.load(workspace);
  ok('measurement persists across save/load', loaded.measurements[KEY].value === 42 && loaded.measurements[KEY].baseline.value === 130);

  // --- back-compat: load an OLD overlay written before the measurements map existed ---
  const old = overlay.EMPTY();
  delete old.measurements;                    // simulate a pre-feature overlay on disk
  old.summaries[KEY] = 'legacy';
  overlay.save(workspace, old);
  const back = overlay.load(workspace);
  ok('old overlay back-fills measurements map', back.measurements && typeof back.measurements === 'object');
  ok('old overlay keeps its other fields', back.summaries[KEY] === 'legacy');
  overlay.setMeasurement(back, KEY, { value: 9 });
  ok('setMeasurement works after back-fill', back.measurements[KEY].value === 9);
} finally {
  for (const d of [workspace, SANDBOX]) fs.rmSync(d, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
