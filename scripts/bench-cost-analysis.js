#!/usr/bin/env node
// Bench token cost analysis: was KB injection worth it?
//
// For each candidate, compares off vs on-search vs on-iterative across:
//   - solve rate (% trials solved)
//   - median output tokens
//   - injection overhead (on_tokens - off_tokens)
//   - lift per 1k tokens overhead (solve_lift / overhead_k)
//   - budget_solved: on-arm trials that solved AND stayed within off-arm token budget
//
// Usage: node scripts/bench-cost-analysis.js [--candidate <c>] [--trial-min <n>]
'use strict';
const fs = require('fs');
const path = require('path');

const RESULTS = path.join(__dirname, '..', 'bench', 'heldout', 'results-heldout.jsonl');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const filterCandidate = arg('candidate', null);
const trialMin = parseInt(arg('trial-min', '0'), 10);

const lines = fs.readFileSync(RESULTS, 'utf8').trim().split('\n')
  .map(l => { try { return JSON.parse(l); } catch { return null; } })
  .filter(Boolean)
  .filter(r => r.outputTokens > 0) // skip rows with no token data
  .filter(r => r.trial >= trialMin)
  .filter(r => !filterCandidate || r.candidate === filterCandidate);

// Group by candidate → arm → trials
const byCA = {};
for (const r of lines) {
  const arm = r.armLabel || r.arm;
  const key = r.candidate;
  if (!byCA[key]) byCA[key] = {};
  if (!byCA[key][arm]) byCA[key][arm] = [];
  byCA[key][arm].push(r);
}

function med(arr) {
  if (!arr.length) return null;
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

function pct(n, d) { return d ? ((n / d) * 100).toFixed(0) + '%' : '-'; }

// Print full report
const candidates = Object.keys(byCA).sort();

console.log('\n=== KB Injection Cost/Lift Analysis ===\n');
console.log('candidate            arm            n    solved  solve%  medOut   overhead  lift/1kT  budgetSolved');
console.log('─'.repeat(105));

for (const cand of candidates) {
  const arms = byCA[cand];
  const armKeys = Object.keys(arms).sort();

  // Find off arm median tokens as budget baseline
  const offTrials = arms['off'] || [];
  const offTokens = offTrials.map(r => r.outputTokens);
  const offMedian = med(offTokens) || 0;
  const offSolveRate = offTrials.length ? offTrials.filter(r => r.solved).length / offTrials.length : 0;

  for (const arm of armKeys) {
    const trials = arms[arm];
    const tokens = trials.map(r => r.outputTokens);
    const solvedCount = trials.filter(r => r.solved).length;
    const solveRate = trials.length ? solvedCount / trials.length : 0;
    const medOut = med(tokens);
    const overhead = arm === 'off' ? 0 : (medOut || 0) - offMedian;
    const liftPct = solveRate - offSolveRate;
    // lift per 1k tokens overhead
    const liftPer1k = overhead > 0 ? ((liftPct * 100) / (overhead / 1000)).toFixed(2) : (arm === 'off' ? '-' : 'free');
    // budget_solved: solved AND outputTokens ≤ off median (only meaningful for on arms)
    const budgetSolved = arm === 'off' ? '-' : trials.filter(r => r.solved && r.outputTokens <= offMedian).length + '/' + trials.length;

    const overheadStr = arm === 'off' ? '-' : (overhead >= 0 ? '+' : '') + overhead;
    console.log(
      cand.padEnd(20),
      arm.padEnd(14),
      String(trials.length).padStart(4),
      String(solvedCount).padStart(6),
      pct(solvedCount, trials.length).padStart(7),
      String(medOut).padStart(8),
      overheadStr.padStart(9),
      String(liftPer1k).padStart(9),
      budgetSolved.padStart(12)
    );
  }
  console.log();
}

// Summary: which candidates show KB lift, which don't
console.log('=== Lift Summary ===\n');
console.log('candidate            off_solve%  best_on_solve%  lift    best_arm        overhead');
console.log('─'.repeat(85));

for (const cand of candidates) {
  const arms = byCA[cand];
  const offTrials = arms['off'] || [];
  const offRate = offTrials.length ? offTrials.filter(r => r.solved).length / offTrials.length : 0;
  const offMed = med(offTrials.map(r => r.outputTokens)) || 0;

  let bestArm = null, bestRate = -1, bestOverhead = 0;
  for (const [arm, trials] of Object.entries(arms)) {
    if (arm === 'off') continue;
    const rate = trials.length ? trials.filter(r => r.solved).length / trials.length : 0;
    if (rate > bestRate) {
      bestRate = rate;
      bestArm = arm;
      bestOverhead = (med(trials.map(r => r.outputTokens)) || 0) - offMed;
    }
  }

  const lift = bestRate - offRate;
  const liftStr = lift > 0 ? '+' + (lift * 100).toFixed(0) + '%' : (lift * 100).toFixed(0) + '%';
  console.log(
    cand.padEnd(20),
    pct(offRate * offTrials.length, offTrials.length).padStart(10),
    pct(bestRate * (arms[bestArm] || []).length, (arms[bestArm] || []).length).padStart(15),
    liftStr.padStart(7),
    (bestArm || '-').padEnd(15),
    bestOverhead ? (bestOverhead >= 0 ? '+' : '') + bestOverhead : '-'
  );
}
console.log();
