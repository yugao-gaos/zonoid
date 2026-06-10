#!/usr/bin/env node
'use strict';
/**
 * onboard-harness.js — cold-vs-KB onboarding-COMPETENCE harness + judge.
 *
 * Adapts the bench-arm A/B skeleton, but the scored outcome is CORRECTNESS, not tokens. For each
 * probe (scripts/onboard-probes.js rubric) it runs TWO arms:
 *   COLD : a headless `claude -p` agent answers from general knowledge only (no KB note injected).
 *   KB   : the SAME agent, but the validated onboarding notes (onboard-notes.json) are prepended as
 *          retrieved context — simulating an onboarded/KB-equipped agent.
 * Each answer is scored by the deterministic rubric. The judge then reports the three headline rates:
 *   cold_solve_rate, kb_solve_rate, and kb_earned_rate = fraction where (KB correct AND cold wrong).
 *
 * The v5 lesson is enforced as a GUARD: if cold_solve_rate is ~1.0 the harness PRINTS A NO-SIGNAL
 * WARNING (both arms ace it ⇒ probes too easy ⇒ reading is null, exactly like v5).
 *
 *   node scripts/onboard-harness.js --probes <probes.json> --notes <onboard-notes.json> [--model opus]
 *        # live: spawn cold + KB claude arms per probe, score, judge   (requires unsandboxed claude)
 *   node scripts/onboard-harness.js --probes <probes.json> --answers <answers.json>
 *        # offline judge: score pre-collected answers (no agent spawn). answers.json:
 *        #   { "<probeId>": { "cold": "<text>", "kb": "<text>" }, ... }
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { score } = require('./onboard-probes.js');

const SELF_REPO = path.resolve(__dirname, '..');
const CLAUDE = '/opt/homebrew/bin/claude';
const TIMEOUT_S = 240;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function loadJSON(p) { return JSON.parse(fs.readFileSync(path.resolve(p), 'utf8')); }

// Build the KB context block from validated notes (what an onboarded agent would have retrieved).
function kbContext(notes) {
  const kept = (notes.kept || []);
  return 'You have onboarded onto this project. Relevant knowledge-base notes you recall:\n' +
    kept.map((n, i) => `- ${n.title}: ${n.summary}`).join('\n') + '\n\n';
}

// One headless answer. arm='cold' => no KB prefix; arm='kb' => KB context prepended.
function runArm(probe, arm, notes, model) {
  const pre = arm === 'kb' ? kbContext(notes) : '';
  const prompt = pre +
    'Answer this question about the project concisely and concretely (2-5 sentences). ' +
    'Do not hedge; state the actual behavior.\n\nQUESTION: ' + probe.question;
  const sessionId = crypto.randomUUID();
  const mcpConfig = path.join(SELF_REPO, 'bench', 'mcp-off.json');
  const args = [
    '-e', `alarm ${TIMEOUT_S}; exec @ARGV`, '--',
    CLAUDE, '-p', prompt,
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--session-id', sessionId, '--model', model,
    '--output-format', 'text',
  ];
  const run = spawnSync('perl', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  return (run.stdout || '').trim();
}

function judge(probes, getAnswer) {
  const rows = [];
  for (const p of probes) {
    const cold = getAnswer(p, 'cold');
    const kb = getAnswer(p, 'kb');
    const sc = score(p, cold);
    const sk = score(p, kb);
    rows.push({
      id: p.id,
      cold_correct: sc.correct, kb_correct: sk.correct,
      kb_earned: sk.correct && !sc.correct,
      cold_missing: sc.missing, kb_missing: sk.missing,
      note_ref: p.note_ref,
    });
  }
  const n = rows.length;
  const coldRate = rows.filter((r) => r.cold_correct).length / n;
  const kbRate = rows.filter((r) => r.kb_correct).length / n;
  const earnedRate = rows.filter((r) => r.kb_earned).length / n;
  return { n, coldRate, kbRate, earnedRate, rows };
}

function report(result) {
  const pct = (x) => (x * 100).toFixed(0) + '%';
  console.log('=== onboarding-competence reading ===');
  console.log(`probes: ${result.n}`);
  console.log(`COLD solve-rate : ${pct(result.coldRate)}  (${Math.round(result.coldRate * result.n)}/${result.n})`);
  console.log(`KB   solve-rate : ${pct(result.kbRate)}  (${Math.round(result.kbRate * result.n)}/${result.n})`);
  console.log(`KB-EARNED-IT    : ${pct(result.earnedRate)}  (kb correct AND cold wrong)`);
  console.log(`competence delta: ${pct(result.kbRate - result.coldRate)}`);
  console.log('');
  for (const r of result.rows) {
    const tag = r.kb_earned ? 'KB-EARNED' : r.cold_correct && r.kb_correct ? 'both-ok' : !r.cold_correct && !r.kb_correct ? 'both-FAIL' : r.cold_correct && !r.kb_correct ? 'KB-REGRESSED' : '?';
    console.log(`  ${r.id} [${tag}] cold=${r.cold_correct ? 'Y' : 'n'} kb=${r.kb_correct ? 'Y' : 'n'}  (${r.note_ref})`);
  }
  console.log('');
  // v5 NO-SIGNAL guard.
  if (result.coldRate >= 0.99) {
    console.log('!! NO-SIGNAL WARNING: cold solve-rate ~= 1.0. Both arms ace the probes -> the reading is NULL');
    console.log('   (exactly the v5 failure mode). Re-calibrate probes HARDER before trusting any delta.');
  } else if (result.earnedRate <= 0) {
    console.log('!! NO competence delta: KB never solved a probe the cold agent missed.');
    console.log('   Either probes are mis-calibrated or the notes are not load-bearing.');
  } else {
    console.log(`>> SIGNAL: KB earned ${(result.earnedRate * 100).toFixed(0)}% of probes (correct where cold failed). Cold < 1.0 confirms calibration.`);
  }
  return result;
}

function main() {
  const probes = loadJSON(arg('probes'));
  const answersPath = arg('answers');
  const outPath = arg('out');
  let result;
  if (answersPath) {
    const answers = loadJSON(answersPath);
    result = judge(probes, (p, arm) => (answers[p.id] || {})[arm] || '');
  } else {
    const notes = loadJSON(arg('notes'));
    const model = arg('model', 'opus');
    console.error(`[harness] live mode: spawning cold+KB arms for ${probes.length} probes (model=${model})…`);
    result = judge(probes, (p, arm) => runArm(p, arm, notes, model));
  }
  report(result);
  if (outPath) { fs.writeFileSync(path.resolve(outPath), JSON.stringify(result, null, 2) + '\n'); console.error(`wrote ${outPath}`); }
}

if (require.main === module) main();
module.exports = { judge, kbContext };
