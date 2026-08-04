#!/usr/bin/env node
// Claude 5 family pricing rows + longest-prefix disambiguation (lib/usage-accounting.js priceSlice).
// Guards the migration invariant: a 'claude-opus-5-*' record id must resolve to the 'claude-opus-5'
// row and NOT fall back to 'claude-opus-4' (same for sonnet-5 vs sonnet-4), while dated 4.x record
// ids keep matching their 4.x rows. Plain-node test (matches test/codex-usage-cost.test.js style):
//   node test/pricing-prefix-claude5.test.js   — exits non-zero on any failure.
'use strict';
const fs = require('fs');
const path = require('path');
const usageAccounting = require('../lib/usage-accounting');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const near = (a, b, eps = 1e-9) => Math.abs(a - b) < eps;

const pricing = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'pricing.json'), 'utf8'));
const models = pricing.models;

// --- 0) The 5-family rows exist with the published rates ---------------------------------------
ok('row: claude-opus-5 $5/$25', models['claude-opus-5'] && models['claude-opus-5'].input === 5 && models['claude-opus-5'].output === 25);
ok('row: claude-sonnet-5 $3/$15', models['claude-sonnet-5'] && models['claude-sonnet-5'].input === 3 && models['claude-sonnet-5'].output === 15);
ok('row: claude-fable-5 $10/$50', models['claude-fable-5'] && models['claude-fable-5'].input === 10 && models['claude-fable-5'].output === 50);
ok('row: legacy claude-opus-4 kept (historical records still price)', !!models['claude-opus-4']);
ok('row: legacy claude-sonnet-4 kept (historical records still price)', !!models['claude-sonnet-4']);

// Price 1M input + 1M output on `id` and return the USD the table yields for it.
function priceUsd(id) {
  const slice = {
    usage: { by_model: { [id]: { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    cost: usageAccounting.emptyCost(),
  };
  usageAccounting.priceSlice(slice, models);
  return slice.cost.by_model[id].usd;
}
const rowUsd = (key) => models[key].input + models[key].output; // 1M+1M → input+output rates

// --- 1) opus-5 record ids resolve to the opus-5 row, not opus-4 --------------------------------
ok('prefix: claude-opus-5 (exact) → opus-5 rates', near(priceUsd('claude-opus-5'), rowUsd('claude-opus-5')));
ok('prefix: claude-opus-5-20260901 (dated) → opus-5 rates', near(priceUsd('claude-opus-5-20260901'), rowUsd('claude-opus-5')));
ok('prefix: opus-5 dated id does NOT price at opus-4 rates', !near(priceUsd('claude-opus-5-20260901'), rowUsd('claude-opus-4')));

// --- 2) sonnet-5 record ids resolve to the sonnet-5 row, not sonnet-4 --------------------------
ok('prefix: claude-sonnet-5 (exact) → sonnet-5 rates', near(priceUsd('claude-sonnet-5'), rowUsd('claude-sonnet-5')));
ok('prefix: claude-sonnet-5-20260901 (dated) → sonnet-5 rates', near(priceUsd('claude-sonnet-5-20260901'), rowUsd('claude-sonnet-5')));
// sonnet-4 and sonnet-5 rows share list rates today; assert row IDENTITY via a rates-diverge probe:
// price against a table where sonnet-4 is perturbed — a sonnet-5 id must be unaffected.
{
  const perturbed = JSON.parse(JSON.stringify(models));
  perturbed['claude-sonnet-4'].output = 999;
  const slice = {
    usage: { by_model: { 'claude-sonnet-5-20260901': { input_tokens: 1e6, output_tokens: 1e6, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
    cost: usageAccounting.emptyCost(),
  };
  usageAccounting.priceSlice(slice, perturbed);
  ok('prefix: sonnet-5 dated id unaffected by sonnet-4 row (matches sonnet-5, not sonnet-4)',
    near(slice.cost.by_model['claude-sonnet-5-20260901'].usd, rowUsd('claude-sonnet-5')));
}

// --- 3) regression: 4.x record ids still match their 4.x rows -----------------------------------
ok('prefix: claude-opus-4-8-20260514 still → opus-4 row', near(priceUsd('claude-opus-4-8-20260514'), rowUsd('claude-opus-4')));
ok('prefix: claude-sonnet-4-6 still → sonnet-4 row', near(priceUsd('claude-sonnet-4-6'), rowUsd('claude-sonnet-4')));
ok('prefix: opus-4 dated id does NOT price at opus-5 rates', !near(priceUsd('claude-opus-4-8-20260514'), rowUsd('claude-opus-5')));

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
