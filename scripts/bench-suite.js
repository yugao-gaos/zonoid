#!/usr/bin/env node
// bench-suite.js — Mixed KB-required + KB-neutral scenario registry + suite runner.
//
// Discovers scenarios from:
//   bench/economy/scenarios/*/scenario.json  (existing economy scenarios)
//   bench/suite/scenarios/*/scenario.json    (new suite scenarios)
//
// Runs bench-economy.js for each via child_process, then aggregates results by kb_required.
//
// Key metric: ON_overhead_neutral — if positive, KB-neutral tasks are penalized by
// the search_knowledge call overhead.
//
// Usage:
//   node scripts/bench-suite.js [--dry-run] [--model sonnet] [--trial 0] [--scenario all|name]
//
// Results appended to: bench/suite/results.jsonl

'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = process.env.ZONOID_REPO || path.resolve(__dirname, '..');
const DAG_MODE = process.argv.includes('--dag');
const BENCH_ECONOMY = path.join(REPO, 'scripts', DAG_MODE ? 'bench-economy-dag.js' : 'bench-economy.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function hasFlag(name) { return process.argv.includes('--' + name); }

const MODEL = arg('model', 'sonnet');
const TRIAL = parseInt(arg('trial', '0'), 10);
const SCENARIO_FILTER = arg('scenario', 'all');
const DRY_RUN = hasFlag('dry-run');

// Discover scenarios from a base directory.
// bench-economy.js uses REPO/bench/economy/scenarios/<name> internally, so we need
// to ensure suite scenarios are accessible to it. We pass --scenario-base to bench-economy
// if it supports it, or copy suite scenarios into economy/scenarios temporarily.
// Cleanest approach: pass --scenario-base to bench-economy.js (added below as a shim).
// Since bench-economy.js doesn't accept --scenario-base today, we run it with an env var
// BENCH_SCENARIO_BASE that overrides its discovery path.

function discoverScenarios(baseDir, tag) {
  const scenarios = [];
  if (!fs.existsSync(baseDir)) return scenarios;
  for (const name of fs.readdirSync(baseDir)) {
    const scenFile = path.join(baseDir, name, 'scenario.json');
    if (!fs.existsSync(scenFile)) continue;
    let meta;
    try { meta = JSON.parse(fs.readFileSync(scenFile, 'utf8')); } catch { continue; }
    scenarios.push({ name: meta.name || name, kb_required: !!meta.kb_required, kb_partial: !!meta.kb_partial, baseDir, tag, meta });
  }
  return scenarios;
}

function runScenario(scenario) {
  // bench-economy.js discovers scenarios under bench/economy/scenarios/<name>.
  // For suite scenarios (different base), we symlink them temporarily or pass env override.
  // We use BENCH_SCENARIO_BASE env var which bench-economy.js reads if present (via patch below).
  // Since we can't patch bench-economy.js here, the simplest approach is to run bench-economy.js
  // with --scenario pointing to the correct name, and override the scenario dir via env var.
  const args = [BENCH_ECONOMY, '--scenario', scenario.name, '--model', MODEL, '--trial', String(TRIAL)];
  if (DRY_RUN) args.push('--dry-run');

  const env = { ...process.env };
  // Tell bench-economy.js where to look for this scenario.
  // We patch bench-economy.js's scenarioDir via BENCH_SCENARIO_BASE.
  if (scenario.tag === 'suite') {
    env.BENCH_SCENARIO_BASE = scenario.baseDir;
  }

  const start = Date.now();
  const result = spawnSync('node', args, {
    cwd: REPO, env, encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const wallMs = Date.now() - start;
  return { exitCode: result.status, stdout: result.stdout, stderr: result.stderr, wallMs };
}

// Parse the last JSON line from bench-economy results.jsonl that matches this scenario+trial.
function readLastResult(scenario) {
  const resultsFile = path.join(REPO, 'bench', 'economy', DAG_MODE ? 'results-dag.jsonl' : 'results.jsonl');
  if (!fs.existsSync(resultsFile)) return null;
  const lines = fs.readFileSync(resultsFile, 'utf8').split('\n').filter(Boolean);
  // Scan backwards for matching scenario+trial.
  for (let i = lines.length - 1; i >= 0; i--) {
    try {
      const row = JSON.parse(lines[i]);
      if (row.scenario === scenario.name && row.trial === TRIAL) return row;
    } catch { /* skip */ }
  }
  return null;
}

async function main() {
  const economyBase = path.join(REPO, 'bench', 'economy', 'scenarios');
  const suiteBase = path.join(REPO, 'bench', 'suite', 'scenarios');

  const economyScenarios = discoverScenarios(economyBase, 'economy');
  const suiteScenarios = discoverScenarios(suiteBase, 'suite');
  let allScenarios = [...economyScenarios, ...suiteScenarios];

  if (SCENARIO_FILTER !== 'all') {
    allScenarios = allScenarios.filter(s => s.name === SCENARIO_FILTER);
    if (allScenarios.length === 0) {
      console.error('No scenario found matching: ' + SCENARIO_FILTER);
      process.exit(2);
    }
  }

  console.log('[suite] Discovered ' + allScenarios.length + ' scenario(s):');
  for (const s of allScenarios) {
    const specPath = path.join(REPO, s.meta.spec);
    const graderPath = path.join(REPO, s.meta.grader);
    const minimalDir = path.join(REPO, s.meta.minimalSource);
    const specOk = fs.existsSync(specPath) ? 'OK' : 'MISSING';
    const graderOk = fs.existsSync(graderPath) ? 'OK' : 'MISSING';
    const minimalOk = fs.existsSync(minimalDir) ? 'OK' : 'MISSING';
    console.log('  ' + s.name + ' [kb_required=' + s.kb_required + ' kb_partial=' + s.kb_partial + ' tag=' + s.tag + ']');
    console.log('    spec=' + specOk + ' grader=' + graderOk + ' minimalSource=' + minimalOk);
  }

  if (DRY_RUN) {
    console.log('\n[suite] --dry-run: validating scenario files only, not running bench-economy arms.');
    let allOk = true;
    for (const s of allScenarios) {
      const specPath = path.join(REPO, s.meta.spec);
      const graderPath = path.join(REPO, s.meta.grader);
      const minimalDir = path.join(REPO, s.meta.minimalSource);
      if (!fs.existsSync(specPath) || !fs.existsSync(graderPath) || !fs.existsSync(minimalDir)) {
        console.error('  FAIL: ' + s.name + ' — missing required files');
        allOk = false;
      }
    }
    if (allOk) console.log('[suite] dry-run PASS — all ' + allScenarios.length + ' scenario(s) valid');
    else { console.error('[suite] dry-run FAIL — see errors above'); process.exit(1); }
    return;
  }

  // --- Run each scenario ---
  const rows = [];
  for (const scenario of allScenarios) {
    console.log('\n[suite] Running scenario: ' + scenario.name + ' (tag=' + scenario.tag + ')');
    const run = runScenario(scenario);
    process.stdout.write(run.stdout || '');
    if (run.stderr) process.stderr.write(run.stderr);
    console.log('[suite] exit=' + run.exitCode + ' wallMs=' + run.wallMs);

    const result = readLastResult(scenario);
    if (result) {
      rows.push({ ...result, kb_required: scenario.kb_required, kb_partial: scenario.kb_partial, tag: scenario.tag });
    } else {
      console.log('[suite] no result row found for ' + scenario.name + ' trial=' + TRIAL);
    }
  }

  // --- Aggregate by kb_required ---
  const kbGroup = rows.filter(r => r.kb_required && !r.skipped);
  const neutralGroup = rows.filter(r => !r.kb_required && !r.skipped);

  function avg(arr, key) {
    if (!arr.length) return null;
    const vals = arr.map(r => r[key]).filter(v => v != null && !isNaN(v));
    return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : null;
  }
  function rate(arr, key) {
    if (!arr.length) return null;
    return arr.filter(r => r[key]).length / arr.length;
  }

  const summary = {
    ts: new Date().toISOString(),
    model: MODEL,
    trial: TRIAL,
    scenarios: rows.map(r => r.scenario),
    kb_required: {
      count: kbGroup.length,
      avg_ON_cost: avg(kbGroup, 'ON_cost'),
      avg_OFF_cost: avg(kbGroup, 'OFF_cost'),
      avg_savings: kbGroup.length ? avg(kbGroup.map(r => ({ v: (r.OFF_cost || 0) - (r.ON_cost || 0) })), 'v') : null,
      solve_rate_ON: rate(kbGroup, 'ON_solved'),
      solve_rate_OFF: rate(kbGroup, 'OFF_solved'),
    },
    kb_neutral: {
      count: neutralGroup.length,
      avg_ON_cost: avg(neutralGroup, 'ON_cost'),
      avg_OFF_cost: avg(neutralGroup, 'OFF_cost'),
      // ON_overhead_neutral: positive = ON arm costs more (search_knowledge penalty)
      ON_overhead_neutral: neutralGroup.length
        ? avg(neutralGroup.map(r => ({ v: (r.ON_cost || 0) - (r.OFF_cost || 0) })), 'v')
        : null,
      solve_rate_ON: rate(neutralGroup, 'ON_solved'),
      solve_rate_OFF: rate(neutralGroup, 'OFF_solved'),
    },
  };

  // --- Print summary table ---
  console.log('\n========== SUITE SUMMARY ==========');
  console.log('Model: ' + MODEL + '  Trial: ' + TRIAL + '  Scenarios: ' + rows.length);
  console.log('');
  console.log('KB-REQUIRED GROUP (' + summary.kb_required.count + ' scenarios):');
  if (kbGroup.length) {
    console.log('  avg ON cost:   ' + fmt(summary.kb_required.avg_ON_cost));
    console.log('  avg OFF cost:  ' + fmt(summary.kb_required.avg_OFF_cost));
    console.log('  avg savings:   ' + fmt(summary.kb_required.avg_savings) + '  (OFF−ON; positive = ON cheaper)');
    console.log('  solve rate ON: ' + pct(summary.kb_required.solve_rate_ON));
    console.log('  solve rate OFF:' + pct(summary.kb_required.solve_rate_OFF));
  } else {
    console.log('  (no data)');
  }
  console.log('');
  console.log('KB-NEUTRAL GROUP (' + summary.kb_neutral.count + ' scenarios):');
  if (neutralGroup.length) {
    console.log('  avg ON cost:          ' + fmt(summary.kb_neutral.avg_ON_cost));
    console.log('  avg OFF cost:         ' + fmt(summary.kb_neutral.avg_OFF_cost));
    const oh = summary.kb_neutral.ON_overhead_neutral;
    const ohStr = oh !== null ? (oh > 0 ? '+' : '') + oh.toFixed(0) + ' (ON costs MORE — search_knowledge penalty)' :
      oh < 0 ? oh.toFixed(0) + ' (ON costs less — unexpected)' : 'n/a';
    console.log('  ON_overhead_neutral:  ' + (oh !== null ? (oh > 0 ? '+' : '') + oh.toFixed(0) : 'n/a'));
    console.log('  solve rate ON:        ' + pct(summary.kb_neutral.solve_rate_ON));
    console.log('  solve rate OFF:       ' + pct(summary.kb_neutral.solve_rate_OFF));
    if (oh !== null && oh > 5000) {
      console.log('  *** WARNING: large ON overhead on neutral tasks — search_knowledge call is expensive ***');
    }
  } else {
    console.log('  (no data)');
  }
  console.log('====================================');

  // --- Append to results.jsonl ---
  const suiteResultsFile = path.join(REPO, 'bench', 'suite', 'results.jsonl');
  fs.mkdirSync(path.dirname(suiteResultsFile), { recursive: true });
  fs.appendFileSync(suiteResultsFile, JSON.stringify(summary) + '\n');
  console.log('\n[suite] Summary appended to ' + suiteResultsFile);
}

function fmt(n) { return n != null ? n.toFixed(0) + ' tok-eq' : 'n/a'; }
function pct(n) { return n != null ? (n * 100).toFixed(0) + '%' : 'n/a'; }

main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
