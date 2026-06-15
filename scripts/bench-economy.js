#!/usr/bin/env node
// bench-economy.js — Token-economy bench: ON (orchestrator) vs OFF (inline) cost comparison.
//
// Measures whether the orchestrator's KB context pays for itself in token cost.
// ON arm: agent gets full MCP + orchestrator, calls search_knowledge for KB context, solves.
// OFF arm: clean environment, no MCP, no KB, no git history, budget cap = ON weighted cost.
//
// Cost formula (input-token-equivalent):
//   weighted = input_tokens + cache_read_tokens*0.1 + cache_creation_tokens*1.25 + output_tokens*5
//
// Usage:
//   node scripts/bench-economy.js --scenario task-transcript [--dry-run] [--model sonnet] [--trial 0]
//   node scripts/bench-economy.js --judge   (print judge displacement only, no bench run)
//
// Results appended to: bench/economy/results.jsonl
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');

const REPO = process.env.ZONOID_REPO || path.resolve(__dirname, '..');
const CLAUDE = '/opt/homebrew/bin/claude';
const TIMEOUT_S = 600;

// Cost weights (input-token-equivalents; see bench-report.js for rationale)
const INPUT_W = 1.0;
const OUTPUT_W = 5.0;
const CACHE_READ_W = 0.1;
const CACHE_CREATION_W = 1.25;

function weightedCost(usage) {
  return (
    (usage.input_tokens || 0) * INPUT_W +
    (usage.output_tokens || 0) * OUTPUT_W +
    (usage.cache_read_input_tokens || 0) * CACHE_READ_W +
    (usage.cache_creation_input_tokens || 0) * CACHE_CREATION_W
  );
}

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function hasFlag(name) { return process.argv.includes('--' + name); }

// Extract weighted token cost from a transcript JSONL file.
function extractWeightedCost(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return 0;
  let total = 0;
  try {
    for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let obj; try { obj = JSON.parse(line); } catch { continue; }
      const usage = (obj.message && obj.message.usage) || obj.usage;
      if (usage) total += weightedCost(usage);
    }
  } catch { /* unreadable */ }
  return total;
}

// Find transcript JSONL for a session under ~/.claude/projects.
function findTranscript(worktreePath, sessionId) {
  const slug = worktreePath.replace(/[^A-Za-z0-9]/g, '-');
  const direct = path.join(process.env.HOME, '.claude', 'projects', slug, `${sessionId}.jsonl`);
  if (fs.existsSync(direct)) return direct;
  const projRoot = path.join(process.env.HOME, '.claude', 'projects');
  try {
    for (const d of fs.readdirSync(projRoot)) {
      const cand = path.join(projRoot, d, `${sessionId}.jsonl`);
      if (fs.existsSync(cand)) return cand;
    }
  } catch { /* ignore */ }
  return null;
}

// Run claude headlessly and return { exitCode, wallMs, transcriptPath }.
function runArm({ prompt, mcpConfig, sessionId, worktree, env, timeoutS }) {
  const args = [
    '-e', `alarm ${timeoutS || TIMEOUT_S}; exec @ARGV`, '--',
    CLAUDE, '-p', prompt,
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--session-id', sessionId, '--model', MODEL,
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions', '--add-dir', worktree,
  ];
  const t0 = Date.now();
  const run = spawnSync('perl', args, { cwd: worktree, env, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  const wallMs = Date.now() - t0;
  const exitCode = run.status === null ? 124 : run.status;
  return { exitCode, wallMs, transcriptPath: findTranscript(worktree, sessionId) };
}

// Grade an artifact using the scenario's grader.
function grade(graderPath, artifactPath) {
  if (!fs.existsSync(artifactPath)) {
    return { ok: false, pass: 0, total: 0, edgePass: 0, edgeTotal: 0, error: 'no artifact' };
  }
  const g = spawnSync('node', [graderPath, artifactPath], { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 });
  try {
    return JSON.parse((g.stdout || '').trim().split('\n').filter(Boolean).pop());
  } catch (e) {
    return { ok: false, pass: 0, total: 0, edgePass: 0, edgeTotal: 0,
      error: 'grader parse fail: ' + (g.stderr || e.message).slice(0, 200) };
  }
}

// Build a clean OFF-arm git repo with no real history.
function buildOffRepo(minimalSourceDir, installDir) {
  fs.mkdirSync(installDir, { recursive: true });
  if (fs.existsSync(minimalSourceDir)) {
    for (const f of fs.readdirSync(minimalSourceDir)) {
      fs.copyFileSync(path.join(minimalSourceDir, f), path.join(installDir, f));
    }
  }
  spawnSync('git', ['init'], { cwd: installDir });
  spawnSync('git', ['config', 'user.email', 'bench@economy.local'], { cwd: installDir });
  spawnSync('git', ['config', 'user.name', 'Economy Bench'], { cwd: installDir });
  spawnSync('git', ['add', '-A'], { cwd: installDir });
  spawnSync('git', ['commit', '--allow-empty', '-m', 'initial'], { cwd: installDir });
}

// Strip ZONOID_* and ORCH_* from env for the OFF arm.
function cleanEnv(base) {
  const env = {};
  for (const [k, v] of Object.entries(base)) {
    if (!k.startsWith('ZONOID_') && !k.startsWith('ORCH_')) env[k] = v;
  }
  return env;
}

const MODEL = arg('model', 'sonnet');
const SCENARIO_NAME = arg('scenario', 'task-transcript');
const TRIAL = parseInt(arg('trial', '0'), 10);
const DRY_RUN = hasFlag('dry-run');
const JUDGE_ONLY = hasFlag('judge');

// Sonnet judge cost estimate: ~$0.003 per verdict (500 input + 200 output tokens at Sonnet pricing)
const SONNET_COST_PER_VERDICT = 0.003;
// High-confidence threshold: shadow verdicts with conf >= this count toward OOD rate calculation
const HIGH_CONF_THRESHOLD = 0.7;
// Sliding window for agreement rate
const AGREEMENT_WINDOW = 100;
// Default promotion threshold (overridden by edge-clf/config.json if present)
const DEFAULT_PROMOTION_THRESHOLD = 0.92;

// Print judge displacement section by reading the judge journal and mode file directly.
function printJudgeDisplacement() {
  const journalPath = path.join(REPO, '.graph', 'judge-journal.jsonl');
  const modePath = path.join(REPO, '.graph', 'edge-clf', 'mode.json');
  const cfgPath = path.join(REPO, '.graph', 'edge-clf', 'config.json');

  // --- Read current mode ---
  let mode = 'sonnet-primary';
  try {
    const modeObj = JSON.parse(fs.readFileSync(modePath, 'utf8'));
    if (modeObj.mode) mode = modeObj.mode;
  } catch { /* file missing → default sonnet-primary */ }

  // --- Read promotion threshold from config ---
  let promotionThreshold = DEFAULT_PROMOTION_THRESHOLD;
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (typeof cfg.promotion_threshold === 'number') promotionThreshold = cfg.promotion_threshold;
  } catch { /* use default */ }

  // --- Parse judge journal ---
  let totalVerdicts = 0;
  const shadowRows = [];
  const byModelVersion = {};
  try {
    for (const line of fs.readFileSync(journalPath, 'utf8').split('\n')) {
      const s = line.trim(); if (!s) continue;
      let obj; try { obj = JSON.parse(s); } catch { continue; }
      totalVerdicts++;
      // Tally by model_version (Sonnet calls — every row is a Sonnet call)
      const mv = obj.model_version || 'unknown';
      byModelVersion[mv] = (byModelVersion[mv] || 0) + 1;
      if (obj.shadow_verdict != null && obj.verdict != null) shadowRows.push(obj);
    }
  } catch { /* journal missing — show zeros */ }

  // --- Agreement rate (last WINDOW shadow rows) ---
  const slice = shadowRows.slice(-AGREEMENT_WINDOW);
  const nSamples = slice.length;
  const agree = slice.filter((r) => r.verdict === r.shadow_verdict).length;
  const agreementRate = nSamples > 0 ? agree / nSamples : 0;
  const promotionReady = agreementRate >= promotionThreshold && nSamples >= AGREEMENT_WINDOW;

  // --- Confidence bucket breakdown ---
  const buckets = { low: { n: 0, agree: 0 }, mid: { n: 0, agree: 0 }, high: { n: 0, agree: 0 } };
  for (const r of slice) {
    const c = typeof r.shadow_conf === 'number' ? r.shadow_conf : null;
    if (c === null) continue;
    const bk = c < 0.5 ? 'low' : c < 0.8 ? 'mid' : 'high';
    buckets[bk].n++;
    if (r.verdict === r.shadow_verdict) buckets[bk].agree++;
  }
  const pct = (d) => d.n > 0 ? Math.round((d.agree / d.n) * 100) + '%' : 'n/a';

  // --- Primary shadow model label ---
  const mvCounts = {};
  for (const r of shadowRows) { const mv = r.model_version || 'unknown'; mvCounts[mv] = (mvCounts[mv] || 0) + 1; }
  const primaryMv = Object.entries(mvCounts).sort((a, b) => b[1] - a[1])[0]?.[0] || 'v1-provisional';

  // --- Cost projection ---
  // OOD rate estimate: rows where learned model is NOT high-confidence
  const highConfShadow = shadowRows.filter((r) => typeof r.shadow_conf === 'number' && r.shadow_conf >= HIGH_CONF_THRESHOLD).length;
  const totalShadow = shadowRows.length;
  const oodRate = totalShadow > 0 ? 1 - (highConfShadow / totalShadow) : 0.10; // default 10% if no data
  const currentCost = totalVerdicts * SONNET_COST_PER_VERDICT;

  let projectedCost, projectedSavings, displacementNote;
  if (mode === 'learned-primary') {
    // Actual displacement: count OOD fallback calls (rows where learned model wasn't confident)
    const oodFallbackCalls = shadowRows.filter((r) => !(typeof r.shadow_conf === 'number' && r.shadow_conf >= HIGH_CONF_THRESHOLD)).length;
    const displacedCalls = totalVerdicts - oodFallbackCalls;
    projectedCost = oodFallbackCalls * SONNET_COST_PER_VERDICT;
    projectedSavings = currentCost - projectedCost;
    displacementNote = 'Sonnet calls avoided: ' + displacedCalls.toLocaleString();
  } else {
    // Projected displacement based on shadow data
    const estOodFallbackRate = oodRate;
    projectedCost = totalVerdicts * estOodFallbackRate * SONNET_COST_PER_VERDICT;
    projectedSavings = currentCost - projectedCost;
    displacementNote = 'est. ' + Math.round(estOodFallbackRate * 100) + '% OOD fallback rate';
  }

  const fmt$ = (n) => '$' + n.toFixed(2);
  const fmtN = (n) => n.toLocaleString();

  const modeLabel = mode === 'learned-primary' ? '[PROMOTED]' : '[NOT PROMOTED]';
  const readyLabel = promotionReady ? '[READY]' : (nSamples < AGREEMENT_WINDOW ? '[INSUFFICIENT DATA]' : '[NOT READY]');

  console.log('\n=== Judge Displacement (shadow ' + primaryMv + ') ===');
  console.log('Mode: ' + mode + '  ' + modeLabel);
  console.log('Total Sonnet verdicts: ' + fmtN(totalVerdicts));
  console.log('Shadow rows (' + primaryMv + '): ' + fmtN(totalShadow));

  // Breakdown by model_version
  if (Object.keys(byModelVersion).length > 0) {
    const lines = Object.entries(byModelVersion).sort((a, b) => b[1] - a[1])
      .map(([mv, n]) => mv + ': ' + fmtN(n)).join(', ');
    console.log('  By model_version: ' + lines);
  }

  if (nSamples < AGREEMENT_WINDOW) {
    console.log('Agreement rate (last ' + AGREEMENT_WINDOW + '): N/A — insufficient shadow data');
  } else {
    console.log('Agreement rate (last ' + AGREEMENT_WINDOW + '): ' + (agreementRate * 100).toFixed(1) + '%  ' + readyLabel);
    console.log('  Conf breakdown: low=' + pct(buckets.low) + ' mid=' + pct(buckets.mid) + ' high=' + pct(buckets.high));
  }
  console.log('Promotion threshold: ' + (promotionThreshold * 100).toFixed(1) + '%');

  console.log('\nCost projection (estimated):');
  console.log('  Current cost (all Sonnet): ' + fmt$(currentCost) + '  (' + fmtN(totalVerdicts) + ' × $' + SONNET_COST_PER_VERDICT + ')');
  console.log('  Projected cost if promoted: ' + fmt$(projectedCost) + '  (' + displacementNote + ')');
  console.log('  Projected savings: ' + fmt$(projectedSavings) + '/run');
}

async function main() {
  // --judge: print displacement section only, skip full bench run.
  if (JUDGE_ONLY) {
    printJudgeDisplacement();
    return;
  }

  printJudgeDisplacement();

  const scenarioBase = process.env.BENCH_SCENARIO_BASE || path.join(REPO, 'bench', 'economy', 'scenarios');
  const scenarioDir = path.join(scenarioBase, SCENARIO_NAME);
  const scenarioFile = path.join(scenarioDir, 'scenario.json');
  if (!fs.existsSync(scenarioFile)) {
    console.error('scenario not found: ' + scenarioFile); process.exit(2);
  }
  const scenario = JSON.parse(fs.readFileSync(scenarioFile, 'utf8'));
  const specPath = path.join(REPO, scenario.spec);
  const graderPath = path.join(REPO, scenario.grader);
  const minimalSourceDir = path.join(REPO, scenario.minimalSource);
  const resultsFile = path.join(REPO, 'bench', 'economy', 'results.jsonl');
  fs.mkdirSync(path.dirname(resultsFile), { recursive: true });

  if (DRY_RUN) {
    console.log('[dry-run] bench-economy smoke test');
    console.log('  scenario:', SCENARIO_NAME);
    console.log('  spec:', specPath, fs.existsSync(specPath) ? 'OK' : 'MISSING');
    console.log('  grader:', graderPath, fs.existsSync(graderPath) ? 'OK' : 'MISSING');
    console.log('  minimalSource:', minimalSourceDir, fs.existsSync(minimalSourceDir) ? 'OK' : 'MISSING');
    console.log('  results will append to:', resultsFile);
    console.log('  model:', MODEL, '| trial:', TRIAL);

    // Smoke-test grader with a known-good frozen artifact.
    const frozenArtifact = path.join(REPO, 'bench', 'heldout', 'frozen',
      'task-transcript-on-search-0', 'resolve-owner-ht.js');
    if (fs.existsSync(frozenArtifact)) {
      const result = grade(graderPath, frozenArtifact);
      console.log('  grader smoke (known-good):', JSON.stringify({
        ok: result.ok, pass: result.pass, total: result.total,
        edgePass: result.edgePass, edgeTotal: result.edgeTotal,
      }));
      if (!result.ok) { console.error('  ERROR: grader !ok on known-good artifact'); process.exit(1); }
    } else {
      console.log('  grader smoke: frozen artifact not found — skipping grader check');
    }

    // Smoke-test weightedCost formula.
    const synth = { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 5000, cache_creation_input_tokens: 0 };
    const expected = 1000 * INPUT_W + 200 * OUTPUT_W + 5000 * CACHE_READ_W + 0 * CACHE_CREATION_W;
    const got = weightedCost(synth);
    console.log('  weightedCost smoke:', got, '(expected', expected + ')', got === expected ? 'OK' : 'MISMATCH');
    if (got !== expected) { console.error('  ERROR: weightedCost mismatch'); process.exit(1); }

    console.log('[dry-run] PASS');
    return;
  }

  // --- Step 1: record bench snapshot timestamp (KB sealed at this point) ---
  const snapshotTs = new Date().toISOString();
  console.log('[economy] scenario=' + SCENARIO_NAME + ' trial=' + TRIAL + ' model=' + MODEL + ' ts=' + snapshotTs);

  // --- Step 2: ON arm — full MCP + orchestrator KB context ---
  const specBody = fs.readFileSync(specPath, 'utf8');
  const onWtRel = 'worktrees/bench/econ-' + SCENARIO_NAME + '-on-' + TRIAL;
  const onWt = path.join(REPO, onWtRel);
  const onBranch = 'orch/bench/econ-' + SCENARIO_NAME + '-on-' + TRIAL;
  spawnSync('git', ['-C', REPO, 'worktree', 'remove', '--force', onWtRel], { stdio: 'ignore' });
  spawnSync('git', ['-C', REPO, 'branch', '-D', onBranch], { stdio: 'ignore' });
  const onAdd = spawnSync('git', ['-C', REPO, 'worktree', 'add', '-b', onBranch, onWtRel, 'HEAD'], { encoding: 'utf8' });
  if (onAdd.status !== 0) { console.error('ON worktree add failed:', onAdd.stderr); process.exit(1); }

  // Strip oracle material so agent cannot inspect grader or prior results.
  fs.rmSync(path.join(onWt, 'bench', 'heldout', 'graders'), { recursive: true, force: true });
  fs.rmSync(path.join(onWt, 'bench', 'heldout', 'frozen'), { recursive: true, force: true });
  fs.rmSync(path.join(onWt, 'bench', 'heldout', 'results-heldout.jsonl'), { force: true });
  fs.rmSync(path.join(onWt, 'bench', 'economy', 'scenarios', SCENARIO_NAME, 'grader.js'), { force: true });
  const specsDir = path.join(onWt, 'bench', 'heldout', 'specs');
  try {
    const thisSpecAbs = path.resolve(path.join(onWt, scenario.spec));
    for (const f of fs.readdirSync(specsDir)) {
      const full = path.join(specsDir, f);
      if (path.resolve(full) !== thisSpecAbs) fs.rmSync(full, { force: true });
    }
  } catch { /* specsDir may not exist */ }
  fs.mkdirSync(path.join(onWt, 'bench', 'sandbox'), { recursive: true });
  if (fs.existsSync(minimalSourceDir)) {
    for (const f of fs.readdirSync(minimalSourceDir)) {
      const src = path.join(minimalSourceDir, f);
      if (fs.statSync(src).isFile()) {
        fs.copyFileSync(src, path.join(onWt, 'bench', 'sandbox', f));
      }
    }
  }

  // ON prompt: mandatory search_knowledge before coding (proven best mode for task-transcript).
  const ON_PREAMBLE =
    'You have the orchestrator-graph MCP. Before writing code you MUST call search_knowledge with a ' +
    'query describing this task, and apply any relevant retrieved note (a recorded decision/gotcha). ' +
    'Graph is READ-ONLY — do NOT create, modify, claim, complete, or record_decision on any tasks/nodes.\n\n';
  const onPrompt = ON_PREAMBLE + specBody.split(REPO).join(onWt);
  const onSessionId = crypto.randomUUID();
  const ORCH_WORKSPACE = process.env.ZONOID_WORKSPACE || process.cwd();

  console.log('[economy] ON arm: session=' + onSessionId);
  const onResult = runArm({
    prompt: onPrompt,
    mcpConfig: path.join(REPO, 'bench', 'mcp-on.json'),
    sessionId: onSessionId, worktree: onWt,
    env: { ...process.env, ORCH_WORKSPACE, ORCH_GATE_OFF: '1' },
  });
  console.log('[economy] ON arm: exit=' + onResult.exitCode + ' wallMs=' + onResult.wallMs);

  const onArtifactPath = path.join(onWt, scenario.artifact);
  const onGrade = grade(graderPath, onArtifactPath);
  const onSolved = !!onGrade.ok;
  const onCost = extractWeightedCost(onResult.transcriptPath);
  console.log('[economy] ON grade: solved=' + onSolved + ' pass=' + onGrade.pass + '/' + onGrade.total +
    ' edgePass=' + onGrade.edgePass + '/' + onGrade.edgeTotal + ' cost=' + onCost.toFixed(0));

  // --- Step 3: skip trial if ON didn't solve ---
  if (!onSolved) {
    const row = { scenario: SCENARIO_NAME, trial: TRIAL, model: MODEL, skipped: true,
      reason: 'ON arm did not solve', snapshotTs, onGrade };
    fs.appendFileSync(resultsFile, JSON.stringify(row) + '\n');
    console.log('[economy] ON arm did not solve — trial skipped');
    return;
  }

  // --- Step 4: construct OFF environment ---
  // Fresh git repo, no .graph, no ZONOID_*/ORCH_* env vars, budget cap = ON cost.
  const offTmp = fs.mkdtempSync(path.join(os.tmpdir(), 'econ-off-' + SCENARIO_NAME + '-'));
  buildOffRepo(minimalSourceDir, offTmp);
  fs.mkdirSync(path.join(offTmp, 'bench', 'sandbox'), { recursive: true });

  const offPrompt = specBody.split(REPO).join(offTmp);
  const offSessionId = crypto.randomUUID();
  const offEnv = { ...cleanEnv(process.env), TMPDIR: offTmp };

  console.log('[economy] OFF arm: session=' + offSessionId + ' budget=' + onCost.toFixed(0) + ' tok-eq');
  const offResult = runArm({
    prompt: offPrompt,
    mcpConfig: path.join(REPO, 'bench', 'mcp-off.json'),
    sessionId: offSessionId, worktree: offTmp, env: offEnv,
  });
  console.log('[economy] OFF arm: exit=' + offResult.exitCode + ' wallMs=' + offResult.wallMs);

  // --- Step 5: grade OFF ---
  const offArtifactPath = path.join(offTmp, scenario.artifact);
  const offGrade = grade(graderPath, offArtifactPath);
  const offSolved = !!offGrade.ok;
  const offCost = extractWeightedCost(offResult.transcriptPath);
  const offBudgetExhausted = offCost >= onCost;
  console.log('[economy] OFF grade: solved=' + offSolved + ' pass=' + offGrade.pass + '/' + offGrade.total +
    ' edgePass=' + offGrade.edgePass + '/' + offGrade.edgeTotal + ' cost=' + offCost.toFixed(0) +
    ' budgetExhausted=' + offBudgetExhausted);

  // --- Step 6: emit per-trial result ---
  // ratio = ON_cost / OFF_cost; < 1 = ON cheaper, > 1 = ON more expensive
  const ratio = offCost > 0 ? onCost / offCost : null;
  const row = {
    scenario: SCENARIO_NAME, trial: TRIAL, model: MODEL, skipped: false, snapshotTs,
    ON_cost: onCost, OFF_cost: offCost, ON_solved: onSolved, OFF_solved: offSolved,
    ratio, offBudgetExhausted,
    onGrade: { pass: onGrade.pass, total: onGrade.total, edgePass: onGrade.edgePass, edgeTotal: onGrade.edgeTotal },
    offGrade: { pass: offGrade.pass, total: offGrade.total, edgePass: offGrade.edgePass, edgeTotal: offGrade.edgeTotal },
    onSessionId, offSessionId,
    onTranscript: onResult.transcriptPath, offTranscript: offResult.transcriptPath,
    onWallMs: onResult.wallMs, offWallMs: offResult.wallMs,
  };
  fs.appendFileSync(resultsFile, JSON.stringify(row) + '\n');
  console.log('[economy] result: ON_cost=' + onCost.toFixed(0) + ' OFF_cost=' + offCost.toFixed(0) +
    ' ratio=' + (ratio !== null ? ratio.toFixed(3) : 'n/a') +
    ' ON_solved=' + onSolved + ' OFF_solved=' + offSolved);
  console.log('[economy] appended to ' + resultsFile);
}

main().catch((e) => { console.error(e && e.message ? e.message : e); process.exit(1); });
