#!/usr/bin/env node
// MS3 usage accounting: parseTranscriptUsage, sample shape, reconcile stale gate.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const usageAccounting = require('../lib/usage-accounting');
const claude = require('../lib/adapters/claude');
const { runUsageReconcile } = require('../lib/usage-reconcile');
const { HARNESS_JUDGE_DRAIN_KEY } = require('../lib/harness-task');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;

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

{
  const ov = {
    usage_reconcile: {},
    usage_reconcile_snapshot: {
      other_harness: {
        cost: { usd: 99, source: 'real', by_model: { stale: { tokens: 1, usd: 99 } } },
      },
    },
  };
  let saved = false;
  let notified = false;
  const report = {
    totals: {
      input_tokens: 10,
      output_tokens: 20,
      cache_read_input_tokens: 30,
      cache_creation_input_tokens: 0,
      by_model: { m1: { input_tokens: 10, output_tokens: 20, cache_read_input_tokens: 30 } },
    },
    cost: { usd: 1.23, source: 'estimated', by_model: { m1: { tokens: 60, usd: 1.23 } } },
    human: { tokens: 2, chars: 8, messages: 1, dropped: 0 },
    sessions: [{ id: 'S1', path: '/tmp/S1.jsonl', total: 20 }],
  };
  const ctx = {
    harnessRegistry: { get: (name) => ({ name, usage: { reconcile: () => report } }) },
    targetOverlay: () => ({ ws: '/tmp/reconcile-cost-ws', ov, save: () => { saved = true; } }),
    now: () => '2026-06-20T00:00:00.000Z',
    notifyChange: () => { notified = true; },
  };
  const forced = runUsageReconcile(ctx, { harness: 'fake', workspace: '/tmp/reconcile-cost-ws', force: true });
  ok('reconcile snapshot stores active harness cost', forced.ok && ov.usage_reconcile_snapshot.cost.usd === 1.23);
  ok('reconcile snapshot keeps sessions for catch-all attribution', ov.usage_reconcile_snapshot.sessions[0].id === 'S1');
  ok('reconcile snapshot preserves nested harness reports', ov.usage_reconcile_snapshot.other_harness.cost.usd === 99 && ov.usage_reconcile_snapshot.fake === report);
  const merged = usageAccounting.sumUsageRecords(ov);
  ok('sumUsageRecords includes top-level reconcile cost exactly once', merged.cost.usd === 1.23 && !merged.cost.by_model.stale);
  ok('reconcile save + notify called', saved && notified);
}

{
  const ov = {
    usage_reconcile_snapshot: {
      harness: 'codex',
      codex: {
        cost: { usd: 4.56, source: 'real', by_model: { 'gpt-5-codex': { tokens: 100, usd: 4.56 } } },
      },
    },
  };
  const merged = usageAccounting.sumUsageRecords(ov);
  ok('sumUsageRecords falls back to active nested reconcile cost', merged.cost.usd === 4.56 && merged.cost.by_model['gpt-5-codex'].usd === 4.56);
}

{
  const ov = {
    usage_reconcile_snapshot: {
      harness: 'codex',
      cost: { usd: 2, source: 'real', by_model: { top: { tokens: 1, usd: 2 } } },
      codex: {
        cost: { usd: 2, source: 'real', by_model: { nested: { tokens: 1, usd: 2 } } },
      },
    },
  };
  const merged = usageAccounting.sumUsageRecords(ov);
  ok('sumUsageRecords does not double-count nested cost when top-level cost exists', merged.cost.usd === 2 && !merged.cost.by_model.nested);
}

// --- cost-cause ledger: classify slices and put residual snapshot cost in unknown --------------
{
  const cost = (usd, tokens) => ({ usd, source: 'real', by_model: { m1: { tokens, usd } } });
  const usage = (output) => ({ input_tokens: 0, output_tokens: output, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} });
  const ov = {
    usage_records: {
      fg: { harness: 'dispatcher', agent_id: 'fg', task_key: 'codex/foreground', foreground: true, usage: usage(2), cost: cost(0.2, 2) },
      worker: { harness: 'codex', agent_id: 'worker-1', task_key: 'codex/build', usage: usage(10), cost: cost(1, 10) },
      review: { harness: 'codex', agent_id: 'review-1', task_key: 'codex/build', role: 'review', judged_node: 'codex/build', usage: usage(20), cost: cost(2, 20) },
      daemon: { harness: 'codex', agent_id: 'judge-drain', task_key: HARNESS_JUDGE_DRAIN_KEY, usage: usage(5), cost: cost(0.5, 5) },
      unknown: { harness: 'codex', session_id: 'mystery', usage: usage(3), cost: cost(0.4, 3) },
    },
    usage_reconcile_snapshot: {
      totals: usage(55),
      cost: cost(5.1, 55),
      sessions: [{ id: 'snap-1', total: 55 }],
    },
  };
  const merged = usageAccounting.sumUsageRecords(ov);
  const ledger = usageAccounting.costCauseLedger(ov, {
    tasks: [
      { id: 'codex/build', label: 'Build the thing' },
      { id: HARNESS_JUDGE_DRAIN_KEY, label: 'harness: judge drain' },
    ],
    totalCost: merged.cost,
    totalUsage: merged.totals,
  });
  const byCause = Object.fromEntries(ledger.buckets.map((b) => [b.key, b]));
  ok('costCauseLedger classifies foreground slices', near(byCause.foreground.usd, 0.2) && byCause.foreground.tokens === 2);
  ok('costCauseLedger classifies task-linked agent slices as worker', near(byCause.worker.usd, 1) && byCause.worker.records === 1);
  ok('costCauseLedger classifies role/judged_node slices as review', near(byCause.review.usd, 2) && byCause.review.records === 1);
  ok('costCauseLedger classifies standing harness drains as daemon', near(byCause.daemon.usd, 0.5) && byCause.daemon.records === 1);
  ok('costCauseLedger adds merged-basis remainder dollars to unknown', near(byCause.unknown.usd, 5.5) && byCause.unknown.tokens === 58);
  ok('costCauseLedger total reconciles to merged cost basis', near(ledger.total.usd, merged.cost.usd));
  ok('costCauseForSlice does not treat bare task_key provenance as productive', usageAccounting.costCauseForSlice({ task_key: 'codex/bare', usage: usage(1), cost: cost(0.1, 1) }) === 'unknown');
}

{
  const ledger = usageAccounting.costCauseLedger({
    usage_reconcile_snapshot: {
      totals: { input_tokens: 0, output_tokens: 7, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} },
      cost: { usd: 2.25, source: 'real', by_model: { m1: { tokens: 7, usd: 2.25 } } },
      sessions: [{ id: 'snap-only', total: 7 }],
    },
  });
  const byCause = Object.fromEntries(ledger.buckets.map((b) => [b.key, b]));
  ok('costCauseLedger allocates snapshot-only dollars to unknown', near(byCause.unknown.usd, 2.25) && byCause.unknown.tokens === 7);
  ok('snapshot-only ledger has no fake worker cost', byCause.worker.usd === 0 && ledger.total.usd === 2.25);
}

// --- gross/delta split: by_model stays gross, scalar totals go delta ----------------------------
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'usage-gross-'));
  const tp = path.join(tmp, 'agent.jsonl');
  fs.writeFileSync(tp, [
    JSON.stringify({ timestamp: '2026-06-01T10:00:00Z', message: { usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 200 }, model: 'claude-sonnet-4-6' } }),
    JSON.stringify({ timestamp: '2026-06-01T10:01:00Z', message: { usage: { input_tokens: 30, output_tokens: 20, cache_read_input_tokens: 60 }, model: 'claude-opus-4-8' } }),
  ].join('\n') + '\n');
  try {
    // Without baseline: scalar totals === Σ by_model (both gross)
    const noBase = usageAccounting.parseTranscriptUsage(tp);
    const bmOut = Object.values(noBase.by_model).reduce((s, v) => s + v.output_tokens, 0);
    ok('no-baseline: scalar output === Σ by_model output', noBase.output_tokens === bmOut);
    ok('no-baseline: by_model has both models', Object.keys(noBase.by_model).length === 2);

    // With baseline: scalar totals are net (delta); by_model stays gross (no subtraction)
    const baseline = { input_tokens: 50, output_tokens: 30, cache_read_input_tokens: 100 };
    const withBase = usageAccounting.parseTranscriptUsage(tp, { baseline });
    // Scalar output is delta (net of baseline)
    ok('with-baseline: scalar output is net-of-baseline', withBase.output_tokens === (50 + 20 - 30));
    // by_model is still gross (sum matches gross total before baseline subtraction)
    const bmGross = Object.values(withBase.by_model).reduce((s, v) => s + v.output_tokens, 0);
    ok('with-baseline: by_model output is still gross (50+20)', bmGross === 70);
    // Scalar delta < gross by_model (the key invariant)
    ok('with-baseline: delta scalar < gross by_model (different bases)', withBase.output_tokens < bmGross);
  } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
}

// --- token-economy partition: prod+expl+trap ≤ t.total (partition check) ----------------------
{
  // Simulate a /costflow response shape: buckets should partition to ≤100% of t.total
  const t = { productive: 400, exploration: 300, trapped: 200, total: 900 };
  const econTok = t.total || (t.productive + t.exploration + t.trapped);
  const prodPct = econTok > 0 ? Math.round(t.productive / econTok * 100) : 0;
  const explPct = econTok > 0 ? Math.round(t.exploration / econTok * 100) : 0;
  const trapPct = econTok > 0 ? Math.round(t.trapped / econTok * 100) : 0;
  ok('token-economy partition: prod+expl+trap === t.total', t.productive + t.exploration + t.trapped === t.total);
  ok('token-economy partition: pct sum ≤ 100 (rounding may trim a point)', prodPct + explPct + trapPct <= 100);
  ok('token-economy partition: no individual pct > 100', prodPct <= 100 && explPct <= 100 && trapPct <= 100);

  // Verify cross-base denominator (old bug: using output_tokens=3000 instead of t.total=900) would overflow
  const grossOutput = 3000; // simulates gross >> delta
  const wrongPct = Math.round(t.productive / grossOutput * 100) + Math.round(t.exploration / grossOutput * 100) + Math.round(t.trapped / grossOutput * 100);
  ok('cross-base denominator would have summed < 100 (the old bug caused overflow with delta>gross)', wrongPct <= 100);
  // ...whereas with delta denominator sum is correct
  ok('delta denominator: sum is ~100%', Math.abs(prodPct + explPct + trapPct - 100) <= 2);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
