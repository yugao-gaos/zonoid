#!/usr/bin/env node
// CDX-3: Codex usage capture + adapter-owned $ pricing + daemon dollar rollup.
// Plain-node test (no framework; matches test/usage-accounting.test.js style). Run:
//   node test/codex-usage-cost.test.js   — exits non-zero on any failure.
//
// Covers:
//   - priceSlice: a slice with known by_model token counts prices to the expected USD via pricing.json
//   - unknown model -> cost.usd stays 0, model noted in cost.unpriced_models (no crash)
//   - codex adapter normalizes BOTH usage shapes (token_count.total_token_usage + exec usage)
//   - codex.usage.normalizeReported on a hook-shaped reported_usage yields a priced slice
//   - codex.usage.estimateFromChars stamps cost.source:'estimated'
//   - sumUsageRecords: mixed real + estimated slices roll up to source:'estimated' (weakest-wins)
//   - recordTaskCost: per-task rollup accumulates cost_usd and degrades cost_source to 'estimated'
'use strict';
const fs = require('fs');
const path = require('path');
const usageAccounting = require('../lib/usage-accounting');
const codex = require('../lib/adapters/codex');
const claude = require('../lib/adapters/claude');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

// Load the shipped rate table so the expected-USD math uses the SAME numbers the adapter ships.
const pricing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pricing.json'), 'utf8'));
const models = pricing.models;

// --- 1) priceSlice: known by_model tokens → expected USD ---------------------------------------
{
  // 1,000,000 input + 1,000,000 output on claude-opus-4-8 → input rate + output rate (per MTok).
  const r = models['claude-opus-4'];
  const slice = {
    usage: { by_model: { 'claude-opus-4-8-20260514': { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 2e6, cache_creation_input_tokens: 0 } } },
    cost: usageAccounting.emptyCost(),
  };
  usageAccounting.priceSlice(slice, models);
  const expected = (1e6 * r.input + 1e6 * r.output + 2e6 * r.cache_read) / 1e6;
  ok('priceSlice: opus by_model prices to expected USD', near(slice.cost.usd, expected));
  ok('priceSlice: longest-prefix matched opus-4-8 → claude-opus-4 row', slice.cost.by_model['claude-opus-4-8-20260514'].usd > 0);
  ok('priceSlice: by_model carries token total', slice.cost.by_model['claude-opus-4-8-20260514'].tokens === 4e6);
}

// --- 2) priceSlice: gpt-5-codex + unknown model ------------------------------------------------
{
  const cr = models['gpt-5-codex'];
  const slice = {
    usage: { by_model: {
      'gpt-5-codex': { input_tokens: 2e6, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 },
      'totally-unknown-model-9000': { input_tokens: 5e6, output_tokens: 5e6 },
    } },
    cost: usageAccounting.emptyCost(),
  };
  usageAccounting.priceSlice(slice, models);
  const expectedCodex = (2e6 * cr.input + 1e6 * cr.output) / 1e6;
  ok('priceSlice: gpt-5-codex prices to expected USD', near(slice.cost.by_model['gpt-5-codex'].usd, expectedCodex));
  ok('priceSlice: total = only the known model (unknown contributes 0)', near(slice.cost.usd, expectedCodex));
  ok('priceSlice: unknown model noted in unpriced_models, no crash', Array.isArray(slice.cost.unpriced_models) && slice.cost.unpriced_models.includes('totally-unknown-model-9000'));
  ok('priceSlice: unknown model row present with usd 0', slice.cost.by_model['totally-unknown-model-9000'].usd === 0);
}

// --- 3) codex adapter normalizes BOTH usage shapes ---------------------------------------------
{
  const { normalizeCodexUsage } = codex._internal;
  // Shape A: token_count.info.total_token_usage (input is GROSS incl cached; output incl reasoning).
  const a = normalizeCodexUsage({ input_tokens: 580345, cached_input_tokens: 372352, output_tokens: 9395, reasoning_output_tokens: 3774, total_tokens: 589740 });
  ok('codex shape A: cache_read = cached_input_tokens', a.cache_read_input_tokens === 372352);
  ok('codex shape A: input = gross − cached (uncached)', a.input_tokens === 580345 - 372352);
  ok('codex shape A: output passes through (incl reasoning)', a.output_tokens === 9395);
  // Shape B: codex exec --json usage (input_token_details.cached_tokens).
  const b = normalizeCodexUsage({ input_tokens: 180, output_tokens: 96, total_tokens: 276, input_token_details: { cached_tokens: 48 }, output_tokens_details: { reasoning_tokens: 22 } });
  ok('codex shape B: cache_read = input_token_details.cached_tokens', b.cache_read_input_tokens === 48);
  ok('codex shape B: input = 180 − 48', b.input_tokens === 132);
  ok('codex shape B: output = 96', b.output_tokens === 96);
}

// --- 4) codex.usage.normalizeReported on a hook-shaped reported_usage → priced slice -----------
{
  // The agent-done.sh hook forwards canonical reported_usage {input,output,cache_read,model}.
  const slice = codex.usage.normalizeReported({ input_tokens: 207993, output_tokens: 9395, cache_read_input_tokens: 372352, model: 'gpt-5-codex' });
  ok('codex normalizeReported: usage threaded', slice.usage.output_tokens === 9395 && slice.usage.cache_read_input_tokens === 372352);
  ok('codex normalizeReported: synthesized by_model from model hint', !!slice.usage.by_model['gpt-5-codex']);
  ok('codex normalizeReported: priced (cost.usd > 0)', slice.cost.usd > 0);
  ok('codex normalizeReported: source real by default', slice.cost.source === 'real');
  const cr = models['gpt-5-codex'];
  const expected = (207993 * cr.input + 9395 * cr.output + 372352 * cr.cache_read) / 1e6;
  ok('codex normalizeReported: USD matches pricing.json', near(slice.cost.usd, expected, 1e-6));
}

// --- 5) codex.usage.estimateFromChars stamps source:'estimated' --------------------------------
{
  const slice = codex.usage.estimateFromChars(4000, { model: 'gpt-5-codex' });
  ok('codex estimate: ~chars/4 output tokens', slice.usage.output_tokens === 1000);
  ok('codex estimate: cost.source = estimated', slice.cost.source === 'estimated');
  ok('codex estimate: still priced (cost.usd > 0)', slice.cost.usd > 0);
}

// --- 6) sumUsageRecords: mixed real + estimated → weakest-source 'estimated' --------------------
{
  const realSlice = claude.usage.normalizeReported({ input_tokens: 1e6, output_tokens: 1e6, by_model: { 'claude-sonnet-4-6': { input_tokens: 1e6, output_tokens: 1e6 } } });
  ok('rollup setup: real slice source real', realSlice.cost.source === 'real');
  const estSlice = codex.usage.estimateFromChars(8000, { model: 'gpt-5-codex' });
  const ov = { usage_records: { a1: realSlice, a2: estSlice } };
  const merged = usageAccounting.sumUsageRecords(ov);
  ok('rollup: cost.usd = sum of both slices', near(merged.cost.usd, realSlice.cost.usd + estSlice.cost.usd, 1e-9));
  ok('rollup: weakest-source wins → estimated', merged.cost.source === 'estimated');
  // All-real control: two real slices stay 'real'.
  const ovReal = { usage_records: { a1: realSlice, a2: claude.usage.normalizeReported({ output_tokens: 5e5, by_model: { 'claude-haiku-4-5': { output_tokens: 5e5 } } }) } };
  ok('rollup: all-real stays real', usageAccounting.sumUsageRecords(ovReal).cost.source === 'real');
}

// --- 7) recordTaskCost: per-task rollup accumulates cost_usd + degrades source ------------------
{
  const ov = {};
  const s1 = claude.usage.normalizeReported({ output_tokens: 1e6, by_model: { 'claude-opus-4-8': { output_tokens: 1e6 } } });
  s1.task_key = 'T1'; s1.agent_id = 'w1'; s1.endedAt = '2026-06-16T10:00:00Z';
  const s2 = codex.usage.estimateFromChars(4000, { model: 'gpt-5-codex' });
  s2.task_key = 'T1'; s2.agent_id = 'w1'; s2.endedAt = '2026-06-16T10:05:00Z'; // re-run: new endedAt
  usageAccounting.recordTaskCost(ov, s1);
  usageAccounting.recordTaskCost(ov, s2);
  const roll = usageAccounting.taskCost(ov, 'T1');
  ok('recordTaskCost: cost_usd accumulates across contributions', near(roll.cost_usd, s1.cost.usd + s2.cost.usd, 1e-9));
  ok('recordTaskCost: cost_source degrades to estimated', roll.cost_source === 'estimated');
  ok('recordTaskCost: attempts counted (2 contributions)', roll.attempts === 2);
  // Idempotency: same finish (same agent_id|endedAt) does not double-count.
  usageAccounting.recordTaskCost(ov, s1);
  ok('recordTaskCost: duplicate finish not re-added', usageAccounting.taskCost(ov, 'T1').attempts === 2);
}

// --- 8) emptySlice carries the cost block ------------------------------------------------------
{
  const s = usageAccounting.emptySlice('codex', {});
  ok('emptySlice: has cost block', s.cost && s.cost.usd === 0 && s.cost.source === 'real' && typeof s.cost.by_model === 'object');
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
