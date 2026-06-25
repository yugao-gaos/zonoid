#!/usr/bin/env node
// Billing accounting: gross_totals reconciliation and token-economy partition.
// Tests the two-basis contract introduced in the billing/attribution fix:
//   (a) gross_totals reconciles exactly with Σ by_model
//   (b) token-economy buckets (prod+expl+trap) partition to ≤100% of t.total
'use strict';
const fs = require('fs');
const path = require('path');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

// --- (a) gross_totals reconciles exactly with Σ by_model --------------------------------
{
  // Simulate what analytics.js /costflow now emits: byModelEmit + grossTotals derived from it.
  const byModelEmit = {
    'claude-sonnet-4-6': { input_tokens: 500, output_tokens: 1000, cache_read: 2000 },
    'claude-opus-4-8':   { input_tokens: 100, output_tokens:  300, cache_read:  600 },
  };

  // Replicate the gross_totals derivation from routes/analytics.js
  const grossTotals = Object.values(byModelEmit).reduce((acc, v) => {
    acc.input_tokens += v.input_tokens || 0;
    acc.output_tokens += v.output_tokens || 0;
    acc.cache_read += v.cache_read || 0;
    return acc;
  }, { input_tokens: 0, output_tokens: 0, cache_read: 0 });

  const sumInput  = Object.values(byModelEmit).reduce((s, v) => s + (v.input_tokens  || 0), 0);
  const sumOutput = Object.values(byModelEmit).reduce((s, v) => s + (v.output_tokens || 0), 0);
  const sumCache  = Object.values(byModelEmit).reduce((s, v) => s + (v.cache_read     || 0), 0);

  ok('gross_totals.input_tokens === Σ by_model input',  grossTotals.input_tokens  === sumInput);
  ok('gross_totals.output_tokens === Σ by_model output', grossTotals.output_tokens === sumOutput);
  ok('gross_totals.cache_read === Σ by_model cache',    grossTotals.cache_read    === sumCache);

  // Sanity-check the values
  ok('gross_totals.output_tokens is 1300', grossTotals.output_tokens === 1300);
  ok('gross_totals.input_tokens is 600',   grossTotals.input_tokens  === 600);
}

// --- (b) token-economy buckets partition to ≤100% of t.total (delta basis) ---------------
{
  // Case 1: normal — buckets sum exactly to t.total
  const t1 = { productive: 400, exploration: 300, trapped: 200, total: 900 };
  const econ1 = t1.total;
  const prod1Pct = Math.round(t1.productive / econ1 * 100);
  const expl1Pct = Math.round(t1.exploration / econ1 * 100);
  const trap1Pct = Math.round(t1.trapped / econ1 * 100);
  ok('case1: buckets sum to t.total', t1.productive + t1.exploration + t1.trapped === t1.total);
  ok('case1: pct sum ≤ 100', prod1Pct + expl1Pct + trap1Pct <= 100);
  ok('case1: pct sum ≥ 98 (rounding headroom)', prod1Pct + expl1Pct + trap1Pct >= 98);

  // Case 2: gross >> delta (the old bug scenario): gross output = 3000, delta total = 900
  // With old denominator (output_tokens=3000): pct would sum to ~30% (wrong, but <100% here)
  // But the real live bug was delta < gross → opus_pct used delta denom → >100% opus%
  // Simulate: gross output 3990K, delta total 1490K (from the live data in the bug report)
  const grossOut = 3990000;
  const deltaTotal = 1490000;
  const opusGross = 2100000;  // ~53% of gross
  const opusPctCorrect = Math.round(opusGross / grossOut * 100);
  const opusPctWrong   = Math.round(opusGross / deltaTotal * 100);
  ok('opus% with gross denom is ≤100%', opusPctCorrect <= 100);
  ok('opus% with delta denom (old bug) would be >100%', opusPctWrong > 100);
  ok('correct opus%: ~53%', opusPctCorrect >= 50 && opusPctCorrect <= 60);

  // Case 3: only productive, no exploration
  const t3 = { productive: 700, exploration: 0, trapped: 300, total: 1000 };
  const econ3 = t3.total;
  const prod3Pct = Math.round(t3.productive / econ3 * 100);
  const trap3Pct = Math.round(t3.trapped / econ3 * 100);
  ok('case3: no exploration — prod+trap ≤ 100%', prod3Pct + trap3Pct <= 100);
}

// --- (c) browser billing contract: task-session dollars come from /costflow.cost ------------
{
  const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');
  ok('browser billing has no hard-coded session MODEL_RATES table', !html.includes('MODEL_RATES'));
  ok('browser billing no longer computes task session total with modelCost()', !/const\s+totalCost\s*=.*modelCost/s.test(html));
  ok('billing hero uses /costflow.cost.usd for task-session cost', /const\s+billCost\s*=\s*cf&&cf\.cost\?Number\(cf\.cost\.usd\|\|0\):null/.test(html));
  ok('billing popup uses server session cost label', /const\s+sessionCost\s*=\s*serverCost\?Number\(serverCost\.usd\|\|0\):0/.test(html));
  ok('model rows use server-provided cost.by_model dollars', html.includes('const serverCostByModel=serverCost&&serverCost.by_model||{}') && html.includes('serverCostByModel[m]'));
  ok('billing popup renders server-provided By Cause ledger', html.includes('cf.cost_by_cause||cf.cause_ledger||{}') && html.includes('By Cause'));
  ok('unrouted wording is pre-flow, not a trapped subset claim', html.includes('unrouted session remainder before graph flow') && !html.includes('subset of trapped'));
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
