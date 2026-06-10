#!/usr/bin/env node
'use strict';
/**
 * onboard-harness.js — HONEST cold-vs-KB onboarding-COMPETENCE harness + LLM judge.
 *
 * For each probe (scripts/onboard-probes.js schema) it runs TWO answering arms and grades each answer
 * by APPLIED CORRECTNESS via a separate LLM judge — never by substring/keyword match against any note.
 *
 *   COLD : a headless `claude -p` agent answers the scenario from general knowledge only. No KB.
 *   KB   : the SAME agent, but first we RETRIEVE real notes the way an onboarded agent would —
 *          live lexical lookup against the running daemon (GET /search with the probe's
 *          retrieval_query), keep the injected [ingest] knowledge-base notes, and prepend them as
 *          recalled context. This exercises the actual retrieval path, not a hand-fed note.
 *
 *   JUDGE: a THIRD headless `claude -p` call per answer. It sees the scenario, the rubric, and the
 *          answer (blind to which arm produced it) and returns {"verdict":"PASS|FAIL","reason":...}.
 *          The rubric describes functional correctness (did the answer reach the right conclusion /
 *          propose the right action), so this measures competence, not note-recall.
 *
 * VALIDITY (the hard lesson, enforced as a guard): the probe set mixes project probes (need the KB)
 * with control probes (a cold agent SHOULD pass from general knowledge). A trustworthy reading needs
 * cold-rate STRICTLY BETWEEN 0 AND 1 — cold passing controls and failing project-specific probes.
 * If cold-rate is 0 or 1 across the board, the harness reports the run as DEGENERATE/NOT-TRUSTWORTHY
 * rather than printing a clean delta.
 *
 *   node scripts/onboard-harness.js --probes <probes.json> [--model sonnet] [--daemon http://localhost:8787] [--out <reading.json>]
 *        # live: retrieve via the running daemon, spawn cold+KB answer arms + judge per probe.
 *   node scripts/onboard-harness.js --probes <probes.json> --answers <answers.json> [--judge-model sonnet] [--out ...]
 *        # offline: judge pre-collected answers (no answer-arm spawn). answers.json:
 *        #   { "<probeId>": { "cold": "<text>", "kb": "<text>" }, ... }
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const { validate } = require('./onboard-probes.js');

const SELF_REPO = path.resolve(__dirname, '..');
const CLAUDE = '/opt/homebrew/bin/claude';
const TIMEOUT_S = 240;
const DEFAULT_DAEMON = 'http://localhost:8787';

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
function loadJSON(p) { return JSON.parse(fs.readFileSync(path.resolve(p), 'utf8')); }

// One headless `claude -p` call, MCP off, sandbox-friendly alarm timeout. Returns trimmed stdout.
function claude(prompt, model) {
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

// Live lexical retrieval against the running daemon — exactly the path an onboarded agent uses.
// Keep ONLY injected [ingest] knowledge-base notes (kind:"note" whose title starts with [ingest]);
// drop task nodes and non-KB notes. This is what GET /search returns for a real onboarding query.
function retrieveKB(daemon, query, k = 6) {
  return new Promise((resolve) => {
    const url = `${daemon}/search?q=${encodeURIComponent(query)}&k=${k}`;
    http.get(url, (res) => {
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => {
        try {
          const j = JSON.parse(body);
          const notes = (j.results || [])
            .filter((r) => r.kind === 'note' && /^\[ingest\]/.test(r.title || ''))
            .map((r) => ({ title: (r.title || '').replace(/^\[ingest\]\s*/, ''), summary: r.summary || '' }));
          resolve(notes);
        } catch { resolve([]); }
      });
    }).on('error', () => resolve([]));
  });
}

function kbBlock(notes) {
  if (!notes.length) return '';
  return 'You have onboarded onto this project. Relevant knowledge-base notes you retrieved:\n' +
    notes.map((n) => `- ${n.title}: ${n.summary}`).join('\n') + '\n\n';
}

function answerPrompt(scenario, kbPrefix) {
  return (kbPrefix || '') +
    'You are answering a question about a specific software project. Answer concisely and concretely ' +
    '(2-6 sentences). State the actual behavior; do not hedge or pad.\n\nQUESTION:\n' + scenario;
}

// LLM judge: applied-correctness grading against the rubric. Blind to which arm produced the answer.
function judgePrompt(probe, answer) {
  return [
    'You are a strict grader. Decide whether a candidate ANSWER is functionally correct for a SCENARIO,',
    'according to a RUBRIC. Grade ONLY on whether the answer reaches the right conclusion / proposes the',
    'right action per the rubric — NOT on wording, keywords, or style. Ignore extra correct detail.',
    'Output STRICT JSON on a single line and nothing else: {"verdict":"PASS","reason":"..."} or {"verdict":"FAIL","reason":"..."}.',
    '',
    'SCENARIO:',
    probe.scenario,
    '',
    'RUBRIC (PASS/FAIL criteria):',
    probe.rubric,
    '',
    'CANDIDATE ANSWER:',
    String(answer || '(empty)'),
  ].join('\n');
}

function parseVerdict(raw) {
  const m = String(raw || '').match(/\{[\s\S]*\}/);
  if (m) { try { const j = JSON.parse(m[0]); if (j.verdict) return { pass: /^pass$/i.test(j.verdict), reason: j.reason || '' }; } catch { /* fall through */ } }
  // Fallback: look for a bare verdict token.
  if (/\bPASS\b/i.test(raw) && !/\bFAIL\b/i.test(raw)) return { pass: true, reason: '(loose parse)' };
  if (/\bFAIL\b/i.test(raw)) return { pass: false, reason: '(loose parse)' };
  return { pass: false, reason: '(unparseable judge output; defaulting FAIL)' };
}

async function run({ probes, daemon, model, judgeModel, answersFile }) {
  const answers = answersFile ? loadJSON(answersFile) : null;
  const rows = [];
  for (const p of probes) {
    let coldA, kbA, retrieved = [];
    if (answers) {
      coldA = (answers[p.id] || {}).cold || '';
      kbA = (answers[p.id] || {}).kb || '';
    } else {
      retrieved = p.kind === 'project' ? await retrieveKB(daemon, p.retrieval_query) : [];
      process.stderr.write(`[${p.id}] retrieved ${retrieved.length} [ingest] note(s); answering cold…`);
      coldA = claude(answerPrompt(p.scenario, ''), model);
      process.stderr.write(' kb…');
      kbA = claude(answerPrompt(p.scenario, kbBlock(retrieved)), model);
      process.stderr.write(' judging…\n');
    }
    const jm = judgeModel || model;
    const coldV = parseVerdict(claude(judgePrompt(p, coldA), jm));
    const kbV = parseVerdict(claude(judgePrompt(p, kbA), jm));
    rows.push({
      id: p.id, kind: p.kind,
      cold_correct: coldV.pass, kb_correct: kbV.pass,
      kb_earned: kbV.pass && !coldV.pass,
      retrieved_n: retrieved.length,
      cold_reason: coldV.reason, kb_reason: kbV.reason,
    });
  }
  return rows;
}

function summarize(rows) {
  const proj = rows.filter((r) => r.kind === 'project');
  const ctl = rows.filter((r) => r.kind === 'control');
  const rate = (arr, key) => (arr.length ? arr.filter((r) => r[key]).length / arr.length : NaN);
  return {
    n: rows.length, n_project: proj.length, n_control: ctl.length,
    cold_rate_overall: rate(rows, 'cold_correct'),
    cold_rate_control: rate(ctl, 'cold_correct'),
    cold_rate_project: rate(proj, 'cold_correct'),
    kb_rate_overall: rate(rows, 'kb_correct'),
    kb_rate_project: rate(proj, 'kb_correct'),
    kb_earned_rate_project: rate(proj, 'kb_earned'), // kb correct AND cold wrong, on project probes
  };
}

function report(rows, s) {
  const pct = (x) => (Number.isNaN(x) ? 'n/a' : (x * 100).toFixed(0) + '%');
  console.log('=== onboarding-competence reading (applied-correctness judge) ===');
  console.log(`probes: ${s.n}  (${s.n_project} project + ${s.n_control} control)`);
  console.log('');
  console.log(`COLD rate  overall : ${pct(s.cold_rate_overall)}`);
  console.log(`COLD rate  control : ${pct(s.cold_rate_control)}   <- should be HIGH (cold knows general SWE)`);
  console.log(`COLD rate  project : ${pct(s.cold_rate_project)}   <- should be LOW (needs project KB)`);
  console.log(`KB   rate  overall : ${pct(s.kb_rate_overall)}`);
  console.log(`KB   rate  project : ${pct(s.kb_rate_project)}`);
  console.log(`KB-EARNED  project : ${pct(s.kb_earned_rate_project)}   (KB correct AND cold wrong, project probes)`);
  console.log('');
  for (const r of rows) {
    const tag = r.kb_earned ? 'KB-EARNED' : r.cold_correct && r.kb_correct ? 'both-ok'
      : !r.cold_correct && !r.kb_correct ? 'both-FAIL' : r.cold_correct && !r.kb_correct ? 'KB-REGRESSED' : 'mixed';
    console.log(`  [${r.kind === 'control' ? 'CTL ' : 'PROJ'}] ${r.id.padEnd(22)} cold=${r.cold_correct ? 'Y' : 'n'} kb=${r.kb_correct ? 'Y' : 'n'} ret=${r.retrieved_n}  [${tag}]`);
  }
  console.log('');

  // VALIDITY GUARD — cold-rate must be strictly between 0 and 1 (degenerate otherwise).
  const verdicts = [];
  const co = s.cold_rate_overall;
  if (!(co > 0 && co < 1)) {
    verdicts.push(`DEGENERATE: cold-rate overall = ${pct(co)} (not strictly between 0 and 1). ` +
      (co >= 1 ? 'Both arms ace everything -> probes too easy, NO competence signal.'
               : 'Cold fails everything incl. controls -> probes mis-calibrated or judge too harsh; the 0 is NOT real competence absence.'));
  }
  if (!(s.cold_rate_control >= 0.5)) {
    verdicts.push(`SUSPECT: cold passes only ${pct(s.cold_rate_control)} of CONTROLS — a competent cold agent should pass these from general knowledge; judge may be miscalibrated.`);
  }
  if (s.kb_earned_rate_project <= 0) {
    verdicts.push('NO DELTA: KB never solved a project probe the cold agent missed — notes not load-bearing, or project probes too easy/hard.');
  }
  const trustworthy = verdicts.length === 0;
  if (trustworthy) {
    console.log(`>> TRUSTWORTHY READING: cold ${pct(co)} (controls ${pct(s.cold_rate_control)}, project ${pct(s.cold_rate_project)}) sits strictly in (0,1);`);
    console.log(`   KB earned ${pct(s.kb_earned_rate_project)} of project probes (correct where cold failed). REAL competence delta.`);
  } else {
    console.log('!! READING NOT TRUSTWORTHY:');
    for (const v of verdicts) console.log('   - ' + v);
  }
  return { trustworthy, verdicts };
}

async function main() {
  const probesPath = arg('probes');
  if (!probesPath) { console.error('usage: onboard-harness.js --probes <probes.json> [--answers <answers.json>] [--model sonnet] [--daemon URL] [--out reading.json]'); process.exit(2); }
  const probes = loadJSON(probesPath);
  if (!validate(probes)) { console.error('probe file failed validation — aborting'); process.exit(1); }

  const answersFile = arg('answers');
  const model = arg('model', 'sonnet');
  const judgeModel = arg('judge-model', model);
  const daemon = arg('daemon', DEFAULT_DAEMON);

  if (answersFile) console.error(`[harness] offline judge over ${probes.length} probes (judge-model=${judgeModel})…`);
  else console.error(`[harness] live: retrieve@${daemon} + cold/kb answers (model=${model}) + judge (model=${judgeModel}) for ${probes.length} probes…`);

  const rows = await run({ probes, daemon, model, judgeModel, answersFile });
  const s = summarize(rows);
  const guard = report(rows, s);

  const out = arg('out');
  if (out) {
    fs.writeFileSync(path.resolve(out), JSON.stringify({ summary: s, guard, rows }, null, 2) + '\n');
    console.error(`wrote ${out}`);
  }
  process.exit(guard.trustworthy ? 0 : 0); // exit 0 either way; degeneracy is a reported FINDING, not a crash
}

if (require.main === module) main();
module.exports = { summarize, parseVerdict, retrieveKB };
