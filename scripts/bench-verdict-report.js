#!/usr/bin/env node
/**
 * bench-verdict-report.js
 * Reads bench/context-inject/results.jsonl and produces a verdict table + recommendation.
 *
 * ARM definitions:
 *   0 = baseline (OFF: no injection)
 *   1 = global-summary (ON)
 *   2 = sliding-window (ON)
 *   3 = both (ON)
 *
 * Usage: node scripts/bench-verdict-report.js [--results <path>]
 */

'use strict';

const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------
// CLI args
// ---------------------------------------------------------------------------
const args = process.argv.slice(2);
let resultsPath = path.join(__dirname, '..', 'bench', 'context-inject', 'results.jsonl');
for (let i = 0; i < args.length - 1; i++) {
  if (args[i] === '--results') resultsPath = args[i + 1];
}
const reportPath = path.join(path.dirname(resultsPath), 'report.md');

// ---------------------------------------------------------------------------
// ARM metadata
// ---------------------------------------------------------------------------
const ARM_NAMES = {
  0: 'baseline (off)',
  1: 'global-summary',
  2: 'sliding-window',
  3: 'both',
};

// ---------------------------------------------------------------------------
// Fisher exact test (two-tailed) via log-factorial approach
// ---------------------------------------------------------------------------

// log(n!) via cumulative sum — exact for all n (no approximation).
// Cached incrementally so each new value costs one Math.log call.
const _logFactCache = [0]; // log(0!) = 0
function logFact(n) {
  if (n < 0) return Infinity;
  for (let i = _logFactCache.length; i <= n; i++) {
    _logFactCache[i] = _logFactCache[i - 1] + Math.log(i);
  }
  return _logFactCache[n];
}

/**
 * Log of the hypergeometric probability for one cell of a 2x2 table:
 *
 *           pass  fail
 *   arm_i:   a     b    (row total = a+b)
 *   baseline: c     d    (row total = c+d)
 *             col1=a+c, col2=b+d, N=a+b+c+d
 *
 * P(X=a) = C(a+b, a) * C(c+d, c) / C(N, a+c)
 */
function logHypergeomProb(a, b, c, d) {
  const N = a + b + c + d;
  return (
    logFact(a + b) + logFact(c + d) +
    logFact(a + c) + logFact(b + d) -
    logFact(N) -
    logFact(a) - logFact(b) -
    logFact(c) - logFact(d)
  );
}

/**
 * Two-tailed Fisher exact p-value.
 *
 * Enumerates all valid values of 'a' (arm pass count) given fixed marginals,
 * then sums the probabilities of tables that are at most as probable as the
 * observed table (standard two-tailed definition).
 *
 * @param {number} armPass   - passes in the treatment arm
 * @param {number} armFail   - failures in the treatment arm
 * @param {number} basePass  - passes in the baseline arm
 * @param {number} baseFail  - failures in the baseline arm
 * @returns {number} p-value in [0, 1]
 */
function fisherExact(armPass, armFail, basePass, baseFail) {
  const row1 = armPass + armFail;   // arm total
  const row2 = basePass + baseFail; // baseline total
  const col1 = armPass + basePass;  // total pass column

  if (row1 === 0 || row2 === 0 || col1 === 0) return 1;

  const aMin = Math.max(0, col1 - row2);
  const aMax = Math.min(row1, col1);

  const logPobs = logHypergeomProb(armPass, armFail, basePass, baseFail);

  let sumP = 0;
  for (let a = aMin; a <= aMax; a++) {
    const b = row1 - a;
    const c = col1 - a;
    const d = row2 - c;
    const logP = logHypergeomProb(a, b, c, d);
    // Two-tailed: include all tables at least as extreme (probability <= observed)
    if (logP <= logPobs + 1e-10) {
      sumP += Math.exp(logP);
    }
  }
  return Math.min(1, sumP);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

if (!fs.existsSync(resultsPath)) {
  console.log('No results yet — run bench-context-inject.js first');
  process.exit(0);
}

const raw = fs.readFileSync(resultsPath, 'utf8').trim();
if (!raw) {
  console.log('No results yet — run bench-context-inject.js first');
  process.exit(0);
}

// Parse JSONL lines, skip malformed
const records = [];
for (const line of raw.split('\n').filter(Boolean)) {
  try {
    records.push(JSON.parse(line));
  } catch (_) {
    // skip malformed lines silently
  }
}

if (records.length === 0) {
  console.log('No results yet — run bench-context-inject.js first');
  process.exit(0);
}

// Aggregate per arm
const arms = {};
for (const r of records) {
  const arm = r.arm ?? 0;
  if (!arms[arm]) arms[arm] = { pass: 0, fail: 0, costSum: 0, count: 0 };
  if (r.pass) arms[arm].pass++;
  else arms[arm].fail++;
  arms[arm].costSum += r.weighted_cost ?? 0;
  arms[arm].count++;
}

const allArmIds = Object.keys(arms).map(Number).sort((a, b) => a - b);

// Baseline (arm 0)
const base = arms[0] || { pass: 0, fail: 0, costSum: 0, count: 0 };
const basePassRate = base.count > 0 ? base.pass / base.count : 0;
const baseCostMean = base.count > 0 ? base.costSum / base.count : 0;

// ---------------------------------------------------------------------------
// Build row data per arm
// ---------------------------------------------------------------------------

function fmtPct(rate) {
  return (rate * 100).toFixed(0) + '%';
}

const rows = [];

for (const armId of allArmIds) {
  const a = arms[armId];
  const passRate = a.count > 0 ? a.pass / a.count : 0;
  const costMean = a.count > 0 ? a.costSum / a.count : 0;

  if (armId === 0) {
    rows.push({
      arm: 0,
      desc: ARM_NAMES[0] || 'baseline (off)',
      count: a.count,
      passRate,
      passDeltaStr: '—',
      costDeltaStr: '—',
      pStr: '—',
      verdict: 'baseline',
    });
    continue;
  }

  // Pass rate delta (percentage points)
  const deltaRaw = passRate - basePassRate;
  const passDeltaStr = (deltaRaw >= 0 ? '+' : '') + (deltaRaw * 100).toFixed(0) + 'pp';

  // Cost delta %
  let costDeltaNum = null;
  let costDeltaStr = '—';
  if (baseCostMean > 0) {
    costDeltaNum = (costMean - baseCostMean) / baseCostMean * 100;
    costDeltaStr = (costDeltaNum >= 0 ? '+' : '') + costDeltaNum.toFixed(1) + '%';
  } else if (costMean > 0) {
    costDeltaStr = '+inf%';
    costDeltaNum = Infinity;
  }

  // Fisher exact p-value (requires both arms to have data)
  let pNum = null;
  let pStr = '—';
  if (base.count > 0 && a.count > 0) {
    pNum = fisherExact(a.pass, a.fail, base.pass, base.fail);
    pStr = pNum.toFixed(2);
  }

  // Verdict
  let verdict;
  const notEnoughTrials = a.count < 3 || base.count < 3;
  if (notEnoughTrials) {
    verdict = 'INCONCLUSIVE';
  } else if (pNum !== null && pNum > 0.1) {
    // Not statistically significant — borderline
    verdict = 'INCONCLUSIVE';
  } else if (passRate >= basePassRate && (costDeltaNum === null || costDeltaNum <= 10)) {
    verdict = 'PASS';
  } else {
    verdict = 'FAIL';
  }

  rows.push({
    arm: armId,
    desc: ARM_NAMES[armId] || `arm-${armId}`,
    count: a.count,
    passRate,
    passDeltaStr,
    costDeltaStr,
    pStr,
    verdict,
    _deltaRaw: deltaRaw,
    _costDeltaNum: costDeltaNum,
    _pNum: pNum,
  });
}

// ---------------------------------------------------------------------------
// Markdown table
// ---------------------------------------------------------------------------

const COL = {
  arm: 3,
  desc: 18,
  trials: 6,
  pass: 6,
  passDelta: 10,
  costDelta: 11,
  pValue: 7,
  verdict: 12,
};

function pad(s, w) {
  return String(s).padEnd(w);
}

const headerRow =
  `| ${pad('arm', COL.arm)} | ${pad('description', COL.desc)} | ${pad('trials', COL.trials)} | ${pad('pass%', COL.pass)} | ${pad('pass_delta', COL.passDelta)} | ${pad('cost_delta%', COL.costDelta)} | ${pad('p_value', COL.pValue)} | ${pad('verdict', COL.verdict)} |`;
const dividerRow =
  `|${'-'.repeat(COL.arm + 2)}|${'-'.repeat(COL.desc + 2)}|${'-'.repeat(COL.trials + 2)}|${'-'.repeat(COL.pass + 2)}|${'-'.repeat(COL.passDelta + 2)}|${'-'.repeat(COL.costDelta + 2)}|${'-'.repeat(COL.pValue + 2)}|${'-'.repeat(COL.verdict + 2)}|`;

const dataRows = rows.map(r =>
  `| ${pad(r.arm, COL.arm)} | ${pad(r.desc, COL.desc)} | ${pad(r.count, COL.trials)} | ${pad(fmtPct(r.passRate), COL.pass)} | ${pad(r.passDeltaStr, COL.passDelta)} | ${pad(r.costDeltaStr, COL.costDelta)} | ${pad(r.pStr, COL.pValue)} | ${pad(r.verdict, COL.verdict)} |`
);

const table = [headerRow, dividerRow, ...dataRows].join('\n');

// ---------------------------------------------------------------------------
// Recommendation paragraph
// ---------------------------------------------------------------------------

const passing = rows.filter(r => r.verdict === 'PASS');
const failing = rows.filter(r => r.verdict === 'FAIL');
const inconclusiveArms = rows.filter(r => r.verdict === 'INCONCLUSIVE');

let rec;
if (passing.length === 0 && failing.length === 0) {
  const why = base.count < 3
    ? 'the baseline has fewer than 3 trials'
    : 'no treatment arms have enough trials or the differences are not statistically significant (p > 0.1)';
  rec = `All treatment arms are INCONCLUSIVE — ${why}. Run more trials before deciding.`;
} else {
  const parts = [];
  if (passing.length > 0) {
    const names = passing.map(r => `arm ${r.arm} (${r.desc})`).join(', ');
    parts.push(`**Adopt:** ${names} — pass rate meets or exceeds baseline with cost overhead within the +10% budget.`);
  }
  if (failing.length > 0) {
    const names = failing.map(r => `arm ${r.arm} (${r.desc})`).join(', ');
    parts.push(`**Reject:** ${names} — pass rate dropped below baseline or cost overhead exceeded +10%.`);
  }
  if (inconclusiveArms.length > 0) {
    const names = inconclusiveArms.map(r => `arm ${r.arm} (${r.desc})`).join(', ');
    parts.push(`**Inconclusive:** ${names} — insufficient data or borderline significance (p > 0.1); collect more trials.`);
  }
  rec = parts.join(' ');
}

// ---------------------------------------------------------------------------
// Compose full report
// ---------------------------------------------------------------------------

const output = [
  '# Context-Injection Benchmark — Verdict Report',
  '',
  `_Generated: ${new Date().toISOString()}_`,
  `_Total records: ${records.length} · Arms: ${allArmIds.join(', ')}_`,
  '',
  '## Results',
  '',
  table,
  '',
  '## Recommendation',
  '',
  rec,
  '',
].join('\n');

// Print to stdout
process.stdout.write(output);

// Write report.md alongside results.jsonl
fs.writeFileSync(reportPath, output, 'utf8');
process.stderr.write(`\nReport written to ${reportPath}\n`);
