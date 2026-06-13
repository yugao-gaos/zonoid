#!/usr/bin/env node
// MS3 usage accounting: parseTranscriptUsage, sample shape, reconcile stale gate.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const usageAccounting = require('../lib/usage-accounting');
const claude = require('../lib/adapters/claude');
const { runUsageReconcile } = require('../lib/usage-reconcile');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

{
  ok('reconcileStale: missing at', usageAccounting.reconcileStale(null));
  ok('reconcileStale: fresh', !usageAccounting.reconcileStale(new Date().toISOString()));
  ok('reconcileStale: old', usageAccounting.reconcileStale('2020-01-01T00:00:00.000Z'));
}

{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-sample-'));
  const tp = path.join(tmp, 'agent.jsonl');
    fs.writeFileSync(tp, [
      JSON.stringify({ timestamp: '2026-06-01T10:00:00Z', message: { usage: { input_tokens: 10, output_tokens: 5 }, model: 'm1' } }),
      JSON.stringify({ timestamp: '2026-06-01T10:01:00Z', message: { usage: { input_tokens: 20, output_tokens: 8 }, model: 'm1' } }),
    ].join('\n') + '\n');
  try {
    const u = usageAccounting.parseTranscriptUsage(tp);
    ok('parse totals', u.input_tokens === 30 && u.output_tokens === 13);
    ok('parse by_model', u.by_model.m1 && u.by_model.m1.output_tokens === 13);
    const slice = claude.usage.sample(tp, { agent_id: 'a1', session_id: 's1', transcript_path: tp });
    ok('sample harness', slice.harness === 'claude');
    ok('sample usage', slice.usage.output_tokens === 13);
    ok('sample fields', slice.agent_id === 'a1' && slice.session_id === 's1');
    const windowed = usageAccounting.parseTranscriptUsage(tp, {
      window: { start: '2099-01-01T00:00:00Z', end: '2099-01-02T00:00:00Z' },
    });
    ok('window filter empty', windowed.output_tokens === 0);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

{
  const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-reconcile-'));
  const WS = fs.mkdtempSync(path.join(SANDBOX, 'ws'));
  process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
  delete require.cache[require.resolve('../lib/overlay')];
  const overlayStore = require('../lib/overlay');
  const ov = overlayStore.EMPTY();
  ov.usage_reconcile = { claude: { at: new Date().toISOString() } };
  overlayStore.save(WS, ov);
  const ctx = {
    harnessRegistry: require('../lib/harness'),
    targetOverlay: () => ({ ws: WS, ov: overlayStore.load(WS), save: () => overlayStore.save(WS, overlayStore.load(WS)) }),
    now: () => new Date().toISOString(),
    notifyChange: () => {},
    PORT: 8787,
  };
  const skipped = runUsageReconcile(ctx, { harness: 'claude', workspace: WS, force: false });
  ok('reconcile gate skips fresh', skipped.ok && skipped.skipped);
  const forced = runUsageReconcile(ctx, { harness: 'claude', workspace: WS, force: true });
  ok('reconcile force runs', forced.ok && !forced.skipped && forced.at);
  fs.rmSync(SANDBOX, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
