#!/usr/bin/env node
'use strict';
/**
 * onboard-loop.js — the ONBOARDING LEARNING LOOP: deepen the KB until competence plateaus.
 *
 * This is the controller that ties the three existing pieces together rather than reinventing them:
 *   - scripts/onboard-mine-{git,docs,structure}.js  -> cheap candidate mining (per round)
 *   - scripts/onboard-learn.js                      -> agentic validate + reversible [ingest] inject
 *   - scripts/onboard-harness.js + onboard-probes   -> applied-correctness competence reading
 *
 * Each round:
 *   1. MEASURE  — run onboard-harness against the current KB; read summary.kb_rate_project
 *                 (share of project probes the KB arm gets right) as the competence metric.
 *   2. LOCATE WEAK AREAS — the project probes whose KB arm FAILED (kb_correct=false). Their
 *                 retrieval_query terms tell the learner WHERE the KB is thin.
 *   3. DEEPEN   — re-mine candidates and run the agentic learner, then inject the validated notes
 *                 (reversible [ingest] overlay notes) so the next round's retrieval can find them.
 *   4. RE-MEASURE next round and compare.
 *
 * STOP when the competence metric PLATEAUS:
 *   - improvement over the previous round < --epsilon (default 0.05), OR
 *   - the metric hits 1.0 (every project probe passes — nothing left to earn), OR
 *   - no weak areas remain to deepen, OR
 *   - --max-rounds reached (default 4).
 * A single below-epsilon round is patience-1 by default (--patience); two such rounds in a row
 * (or the first if patience=1) ends the loop. The plateau is the POINT — we stop spending agent
 * budget once deepening the KB stops moving the competence needle.
 *
 *   node scripts/onboard-loop.js --repo <abs> [--probes <p.json>] [--model sonnet]
 *        [--max-rounds 4] [--epsilon 0.05] [--patience 1] [--daemon URL] [--out <loop.json>]
 *        [--no-inject]            # measure+mine+learn but never mutate the graph (analysis only)
 *        [--dry-run]             # SELF-TEST: no agent spawns. Uses --answers for the harness and
 *                                #  a stubbed learner so the control flow can be exercised offline.
 *        [--answers <a.json>]    # (dry-run) pre-collected cold/kb answers fed to the harness judge.
 *                                #  In dry-run with --answers-rounds, later rounds read alternate
 *                                #  answer files to simulate the KB improving across rounds.
 *        [--batch <N>]           # drain batch size for queue-based learning (default 50).
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SELF_REPO = path.resolve(__dirname, '..');
const NODE = process.execPath;
const DEFAULT_DAEMON = process.env.ORCH_DAEMON || 'http://localhost:8787';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes('--' + name);
function loadJSON(p, def) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; } }

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'], maxBuffer: 64 * 1024 * 1024, windowsHide: true, ...opts });
  return r;
}

// ---- step wrappers: each shells the existing script, never reimplements it ------------------

function mine(repoAbs, outDir) {
  for (const s of ['onboard-mine-git.js', 'onboard-mine-docs.js', 'onboard-mine-config.js']) {
    const r = sh(NODE, [path.join(SELF_REPO, 'scripts', s), '--repo', repoAbs, '--out', outDir]);
    if (r.status !== 0) console.error(`[loop] WARN: ${s} exited ${r.status} (continuing)`);
  }
  // structure miner takes --out as a DIR (it appends /structure.json itself).
  const rs = sh(NODE, [path.join(SELF_REPO, 'scripts', 'onboard-mine-structure.js'), '--repo', repoAbs, '--out', outDir]);
  if (rs.status !== 0) console.error(`[loop] WARN: onboard-mine-structure.js exited ${rs.status} (continuing)`);
}

// Queue-based learn and inject flow.
// 1. --enqueue: mine all candidates into a queue file (fast, no LLM).
// 2. --drain --batch N: process batches until the queue is drained (cursor === total).
// 3. When done, --inject --confirm as usual.
// Falls back to the legacy single-pass learn if no queue file exists (backward compat).
function learnAndInject(repoAbs, model, inject, outDir, batchSize, dispatch) {
  const learnScript = path.join(SELF_REPO, 'scripts', 'onboard-learn.js');
  const queueFile = path.join(outDir, 'onboard-queue.json');

  // Check if we should use queue-based mode or fall back to single-pass.
  // Use queue mode if --enqueue produces a queue file (which we can then drain).
  // If a queue file already exists from a previous enqueue, skip re-enqueuing.
  const hasExistingQueue = fs.existsSync(queueFile);
  if (!hasExistingQueue) {
    // Enqueue: assemble all candidates, write the queue file (fast, no LLM).
    const enq = sh(NODE, [learnScript, '--repo', repoAbs, '--in', outDir, '--enqueue']);
    if (enq.status !== 0) {
      console.error(`[loop] --enqueue failed (exit ${enq.status}); falling back to single-pass learn.`);
      return learnAndInjectSinglePass(repoAbs, model, inject);
    }
  } else {
    // Check if already fully drained from a previous run.
    const statusR = sh(NODE, [learnScript, '--repo', repoAbs, '--in', outDir, '--queue-status'], { stdio: ['ignore', 'pipe', 'pipe'] });
    const statusJSON = loadJSON('/dev/stdin', null); // won't work; parse stdout directly
    let status = null;
    try { status = JSON.parse(statusR.stdout || ''); } catch { /* ignore */ }
    if (status && status.done) {
      console.error('[loop] queue already drained; skipping enqueue/drain.');
      // Still proceed to inject if needed.
      if (!inject) { console.error('[loop] --no-inject: notes written but NOT injected.'); return false; }
      const inj = sh(NODE, [learnScript, '--repo', repoAbs, '--in', outDir, '--inject', '--confirm']);
      if (inj.status !== 0) { console.error(`[loop] inject failed (exit ${inj.status}).`); return false; }
      return true;
    }
  }

  // Dispatch mode: enqueue done; let the orchestrator drive drain batches as capacity allows.
  if (dispatch) {
    const statusR = sh(NODE, [learnScript, '--repo', repoAbs, '--in', outDir, '--queue-status'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let status = null;
    try { status = JSON.parse(statusR.stdout || ''); } catch { /* ignore */ }
    console.error(`[loop] dispatch mode: ${status ? status.remaining : '?'} candidates remaining — process via drain_kb_batch MCP tool or POST /onboard/drain-next`);
    return 'dispatched';
  }

  // Drain loop: keep calling --drain --batch N until queue is done.
  const effectiveBatch = String(batchSize || 50);
  let drained = false;
  for (let attempt = 0; attempt < 1000; attempt++) {
    // Check current status.
    const statusR = sh(NODE, [learnScript, '--repo', repoAbs, '--in', outDir, '--queue-status'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let status = null;
    try { status = JSON.parse(statusR.stdout || ''); } catch { /* ignore */ }
    if (status && status.done) { drained = true; break; }

    const drainR = sh(NODE, [learnScript, '--repo', repoAbs, '--in', outDir, '--drain', '--batch', effectiveBatch, '--model', model]);
    if (drainR.status !== 0) {
      console.error(`[loop] --drain failed (exit ${drainR.status}); aborting drain loop.`);
      break;
    }

    // Re-check status after drain.
    const statusR2 = sh(NODE, [learnScript, '--repo', repoAbs, '--in', outDir, '--queue-status'], { stdio: ['ignore', 'pipe', 'pipe'] });
    let status2 = null;
    try { status2 = JSON.parse(statusR2.stdout || ''); } catch { /* ignore */ }
    if (status2 && status2.done) { drained = true; break; }
  }

  if (!drained) {
    console.error('[loop] WARN: drain loop ended without completing the queue.');
    return false;
  }

  if (!inject) { console.error('[loop] --no-inject: validated notes written but NOT injected.'); return false; }
  const inj = sh(NODE, [learnScript, '--repo', repoAbs, '--in', outDir, '--inject', '--confirm']);
  if (inj.status !== 0) { console.error(`[loop] inject failed (exit ${inj.status}).`); return false; }
  return true;
}

// Legacy single-pass learn+inject (used as fallback if --enqueue fails).
function learnAndInjectSinglePass(repoAbs, model, inject) {
  const learnScript = path.join(SELF_REPO, 'scripts', 'onboard-learn.js');
  const learn = sh(NODE, [learnScript, '--repo', repoAbs, '--model', model]);
  if (learn.status !== 0) { console.error(`[loop] learner failed (exit ${learn.status}); skipping inject this round.`); return false; }
  if (!inject) { console.error('[loop] --no-inject: validated notes written but NOT injected.'); return false; }
  const inj = sh(NODE, [learnScript, '--repo', repoAbs, '--inject', '--confirm']);
  if (inj.status !== 0) { console.error(`[loop] inject failed (exit ${inj.status}).`); return false; }
  return true;
}

// Run the competence harness and return its parsed {summary, guard, rows}. Live unless dry-run.
// --harness-cmd lets a hermetic self-test substitute a stub that emits scripted readings (it gets
//   <probesPath> <readingOut> <round>); by default we shell the REAL onboard-harness.js.
function measure({ probesPath, model, daemon, readingOut, dryRun, answersFile, harnessCmd, round }) {
  if (harnessCmd) {
    const r = sh('sh', ['-c', `${harnessCmd} ${JSON.stringify(probesPath)} ${JSON.stringify(readingOut)} ${round}`]);
    if (r.status !== 0 && !fs.existsSync(readingOut)) throw new Error(`stub harness produced no reading (exit ${r.status})`);
    return loadJSON(readingOut, null);
  }
  const a = [path.join(SELF_REPO, 'scripts', 'onboard-harness.js'), '--probes', probesPath, '--out', readingOut];
  if (dryRun) { a.push('--answers', answersFile); }
  else { a.push('--model', model, '--daemon', daemon); }
  const r = sh(NODE, a);
  if (r.status !== 0 && !fs.existsSync(readingOut)) {
    throw new Error(`harness produced no reading (exit ${r.status})`);
  }
  return loadJSON(readingOut, null);
}

// The weak project probes: KB arm did NOT reach a correct answer -> KB is thin there.
function weakAreas(reading) {
  return (reading.rows || []).filter((r) => r.kind === 'project' && !r.kb_correct)
    .map((r) => ({ id: r.id, reason: r.kb_reason }));
}

// ---- dry-run stub learner: simulate the KB improving by swapping answer files per round -----
// In a real run the learner mutates the live graph and the NEXT measure picks up new [ingest]
// notes. Offline we can't spawn agents, so --answers-rounds lets the self-test feed a stronger
// answer set on later rounds, exercising the SAME plateau-detection control flow honestly.
function answersForRound(round, baseAnswers, roundsList) {
  if (roundsList && roundsList[round]) return roundsList[round];
  return baseAnswers;
}

(async () => {
  const repo = arg('repo');
  if (!repo || !fs.existsSync(repo)) {
    console.error('usage: onboard-loop.js --repo <abs> [--probes p.json] [--max-rounds 4] [--epsilon 0.05] [--dry-run --answers a.json] [--batch 50]');
    process.exit(2);
  }
  const repoAbs = path.resolve(repo);
  const repoName = path.basename(repoAbs);
  const outDir = path.resolve(arg('in', path.join(SELF_REPO, 'bench', 'onboard', repoName)));
  fs.mkdirSync(outDir, { recursive: true });

  const probesPath = arg('probes', path.join(outDir, 'probes.json'));
  if (!fs.existsSync(probesPath)) { console.error(`no probes at ${probesPath} — generate them first (onboard-probes schema).`); process.exit(1); }

  const model = arg('model', 'sonnet');
  const daemon = arg('daemon', DEFAULT_DAEMON);
  const maxRounds = parseInt(arg('max-rounds', '4'), 10) || 4;
  const epsilon = parseFloat(arg('epsilon', '0.05'));
  const patience = parseInt(arg('patience', '1'), 10) || 1;
  const inject = !has('no-inject') && !has('dry-run');
  const dryRun = has('dry-run');
  const harnessCmd = arg('harness-cmd', null); // hermetic self-test hook; default = real harness
  const batchSize = parseInt(arg('batch', '50'), 10) || 50;
  const dispatch = has('dispatch');

  // dry-run answer plumbing
  const baseAnswers = dryRun ? arg('answers') : null;
  if (dryRun && !baseAnswers) { console.error('--dry-run requires --answers <a.json>'); process.exit(2); }
  const roundsList = dryRun && arg('answers-rounds') ? arg('answers-rounds').split(',') : null;

  console.error(`[loop] repo=${repoAbs} probes=${path.basename(probesPath)} max-rounds=${maxRounds} epsilon=${epsilon} inject=${inject} dry-run=${dryRun} batch=${batchSize}`);

  const history = [];
  let prevMetric = null;
  let staleRounds = 0;
  let stopReason = `max-rounds (${maxRounds}) reached`;

  for (let round = 0; round < maxRounds; round++) {
    console.error(`\n===== ROUND ${round} : MEASURE =====`);
    const readingOut = path.join(outDir, `loop-reading-r${round}.json`);
    const answersFile = dryRun ? answersForRound(round, baseAnswers, roundsList) : null;
    const reading = measure({ probesPath, model, daemon, readingOut, dryRun, answersFile, harnessCmd, round });
    if (!reading) throw new Error(`round ${round}: no reading`);

    const metric = reading.summary.kb_rate_project;          // competence = KB arm correctness on project probes
    const earned = reading.summary.kb_earned_rate_project;   // delta vs cold (for reporting/trust)
    const weak = weakAreas(reading);
    const delta = prevMetric == null ? null : metric - prevMetric;
    history.push({
      round, kb_rate_project: metric, kb_earned_rate_project: earned,
      cold_rate_project: reading.summary.cold_rate_project,
      trustworthy: reading.guard && reading.guard.trustworthy,
      delta, weak_ids: weak.map((w) => w.id),
    });
    console.error(`[loop] round ${round}: kb_rate_project=${(metric * 100).toFixed(0)}% earned=${(earned * 100).toFixed(0)}% ` +
      `delta=${delta == null ? 'n/a' : (delta >= 0 ? '+' : '') + (delta * 100).toFixed(0) + '%'} weak=[${weak.map((w) => w.id).join(', ') || 'none'}]`);

    // ---- PLATEAU / STOP checks -------------------------------------------------------------
    if (metric >= 1) { stopReason = 'competence saturated (kb_rate_project = 100%)'; break; }
    if (weak.length === 0) { stopReason = 'no weak project probes left to deepen'; break; }
    if (delta != null && delta < epsilon) {
      staleRounds++;
      console.error(`[loop] below-epsilon round (${staleRounds}/${patience}): delta ${(delta * 100).toFixed(0)}% < epsilon ${(epsilon * 100).toFixed(0)}%`);
      if (staleRounds >= patience) { stopReason = `competence PLATEAUED (delta < ${epsilon} for ${patience} round(s))`; break; }
    } else if (delta != null) {
      staleRounds = 0; // real improvement resets patience
    }
    if (round === maxRounds - 1) break; // last round already measured; don't deepen past the cap

    // ---- DEEPEN the KB on the weak areas --------------------------------------------------
    console.error(`===== ROUND ${round} : DEEPEN (weak: ${weak.map((w) => w.id).join(', ')}) =====`);
    if (dryRun || harnessCmd) {
      console.error('[loop] dry-run/stub: skipping live mine/learn/inject (KB change simulated upstream).');
    } else {
      mine(repoAbs, outDir);
      // Use queue-based learn+inject if not in dry-run.
      const injected = learnAndInject(repoAbs, model, inject, outDir, batchSize, dispatch);
      if (!injected && inject) console.error('[loop] WARN: deepen produced no injected notes this round; next measure may be flat.');
    }
    prevMetric = metric;
  }

  // ---- final report ----------------------------------------------------------------------
  const last = history[history.length - 1];
  const out = {
    repo: repoAbs, probes: path.basename(probesPath), model, dry_run: dryRun, inject,
    epsilon, max_rounds: maxRounds, patience,
    rounds: history.length, stop_reason: stopReason,
    final_kb_rate_project: last.kb_rate_project,
    final_kb_earned_rate_project: last.kb_earned_rate_project,
    history,
  };
  const outPath = arg('out', path.join(outDir, 'loop-summary.json'));
  fs.writeFileSync(outPath, JSON.stringify(out, null, 2) + '\n');

  console.log('\n=== ONBOARDING LEARNING LOOP — summary ===');
  console.log(`repo: ${repoAbs}`);
  console.log(`rounds run: ${history.length}   stop: ${stopReason}`);
  for (const h of history) {
    console.log(`  r${h.round}: kb_rate_project=${(h.kb_rate_project * 100).toFixed(0)}%  earned=${(h.kb_earned_rate_project * 100).toFixed(0)}%  ` +
      `delta=${h.delta == null ? '  n/a' : (h.delta >= 0 ? '+' : '') + (h.delta * 100).toFixed(0) + '%'}  weak=[${h.weak_ids.join(', ') || 'none'}]`);
  }
  console.log(`final competence (kb_rate_project): ${(last.kb_rate_project * 100).toFixed(0)}%`);
  console.log(`wrote ${outPath}`);
})().catch((e) => { console.error(`[loop] FATAL: ${e.message}`); process.exit(1); });
