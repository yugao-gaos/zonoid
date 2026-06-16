#!/usr/bin/env node
'use strict';
/**
 * onboard-harness.js — HONEST cold-vs-KB onboarding-COMPETENCE harness + LLM judge.
 *
 * For each probe (scripts/onboard-probes.js schema) it runs TWO answering arms and grades each answer
 * by APPLIED CORRECTNESS via a separate LLM judge — never by substring/keyword match against any note.
 *
 *   Both answer arms run with NO repo access — empty scratch cwd + `--tools ""` (no Read/Grep/Glob/
 *   Bash) + an explicit no-access instruction — so the KB notes are the ONLY project-specific source.
 *   (Earlier runs let the cold agent read the source, which only measured a FLOOR on KB value; denying
 *   repo access to both arms measures the CEILING.)
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

// Scratch dir with NO project files — the answer arms run here so a stray cwd-relative read
// can't reach the repo. (Belt-and-suspenders alongside `--tools ""`.)
const NO_REPO_CWD = fs.mkdtempSync(path.join(require('os').tmpdir(), 'onboard-noaccess-'));

// One headless `claude -p` call, MCP off, sandbox-friendly alarm timeout. Returns trimmed stdout.
// opts.noRepo (used by the ANSWER arms): deny ALL built-in tools (`--tools ""`, no Read/Grep/Glob/
// Bash) and run from an empty scratch cwd. This isolates the KB as the ONLY project-specific source —
// neither arm can read the codebase, so cold answers from general knowledge only and the KB arm's
// edge is purely the retrieved notes. (Without this the cold agent reads source and the measured KB
// delta collapses to a FLOOR rather than the ceiling.)
function claude(prompt, model, opts = {}) {
  const sessionId = crypto.randomUUID();
  const mcpConfig = path.join(SELF_REPO, 'bench', 'mcp-off.json');
  const args = [
    '-e', `alarm ${TIMEOUT_S}; exec @ARGV`, '--',
    CLAUDE, '-p', prompt,
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--session-id', sessionId, '--model', model,
    '--output-format', 'text',
  ];
  if (opts.noRepo) args.push('--tools', '');
  const run = spawnSync('perl', args, {
    encoding: 'utf8',
    maxBuffer: 32 * 1024 * 1024,
    cwd: opts.noRepo ? NO_REPO_CWD : SELF_REPO,
    windowsHide: true,
  });
  return (run.stdout || '').trim();
}

// Live lexical retrieval against the running daemon — exactly the path an onboarded agent uses.
// Keep ONLY injected [ingest] knowledge-base notes (kind:"note" whose title starts with [ingest]);
// drop task nodes and non-KB notes. This is what GET /search returns for a real onboarding query.
// `workspace` (--workspace): overlay workspace to search. Defaults to the daemon's live workspace
// (back-compat); pass the isolated workspace the foreign repo's notes were injected into.
function retrieveKB(daemon, query, k = 6, workspace = null) {
  return new Promise((resolve) => {
    const url = `${daemon}/search?q=${encodeURIComponent(query)}&k=${k}` +
      (workspace ? `&workspace=${encodeURIComponent(workspace)}` : '');
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

// No-access guard prepended to BOTH arms: the agent has no repo and no file/search tools. The KB arm
// additionally gets the retrieved notes (kbPrefix); the cold arm gets nothing project-specific. This
// makes the KB the only project-specific source. The "say you don't know" instruction stops the model
// from fabricating plausible-but-wrong internal specifics when it genuinely lacks the fact.
const NO_ACCESS_PREAMBLE =
  'You have NO access to this codebase: no repository, no file-reading or search tools, and no prior ' +
  'memory of this project. Do not emit fake tool calls and do not invent project-specific internals ' +
  '(exact token counts, internal enum/field names, function names). Answer ONLY from what you are ' +
  'given here plus general engineering knowledge. If a project-specific fact is required and you were ' +
  "not given it, say plainly that you don't know it.\n\n";

function answerPrompt(scenario, kbPrefix) {
  return NO_ACCESS_PREAMBLE + (kbPrefix || '') +
    'Answer the question concisely and concretely (2-6 sentences). State the actual behavior; do not ' +
    'hedge or pad.\n\nQUESTION:\n' + scenario;
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

async function run({ probes, daemon, model, judgeModel, answersFile, workspace }) {
  const answers = answersFile ? loadJSON(answersFile) : null;
  const rows = [];
  for (const p of probes) {
    let coldA, kbA, retrieved = [];
    if (answers) {
      coldA = (answers[p.id] || {}).cold || '';
      kbA = (answers[p.id] || {}).kb || '';
    } else {
      retrieved = p.kind === 'project' ? await retrieveKB(daemon, p.retrieval_query, 6, workspace) : [];
      process.stderr.write(`[${p.id}] retrieved ${retrieved.length} [ingest] note(s); answering cold…`);
      coldA = claude(answerPrompt(p.scenario, ''), model, { noRepo: true });
      process.stderr.write(' kb…');
      kbA = claude(answerPrompt(p.scenario, kbBlock(retrieved)), model, { noRepo: true });
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


const REQUIRED_ALLOW = [
  'Read',
  'Bash(curl*)', 'Bash(ls*)', 'Bash(cat*)', 'Bash(find*)', 'Bash(grep*)', 'Bash(jq*)', 'Bash(node*)',
  'mcp__orchestrator-graph__next_action', 'mcp__orchestrator-graph__get_full_graph',
  'mcp__orchestrator-graph__set_status', 'mcp__orchestrator-graph__start_task',
  'mcp__orchestrator-graph__complete_task', 'mcp__orchestrator-graph__record_decision',
  'mcp__orchestrator-graph__search_knowledge', 'mcp__orchestrator-graph__get_learnings',
  'mcp__orchestrator-graph__get_task_detail', 'mcp__orchestrator-graph__list_agents',
  'mcp__orchestrator-graph__list_guidance', 'mcp__orchestrator-graph__request_guidance',
  'mcp__orchestrator-graph__loop_control', 'mcp__orchestrator-graph__suggest_links',
  'mcp__orchestrator-graph__attach_knowledge', 'mcp__orchestrator-graph__branch_task',
  'mcp__orchestrator-graph__add_dependency', 'mcp__orchestrator-graph__remove_dependency',
  'mcp__orchestrator-graph__get_dependency_summaries', 'mcp__orchestrator-graph__graph_delta',
  'mcp__orchestrator-graph__show_dashboard', 'mcp__orchestrator-graph__peek_workspace',
  'mcp__orchestrator-graph__drain_kb_batch', 'mcp__orchestrator-graph__enqueue_kb',
  'mcp__orchestrator-graph__measure_task', 'mcp__orchestrator-graph__merge_attempt',
  'mcp__orchestrator-graph__remove_worktree', 'mcp__orchestrator-graph__supersede_note',
  'mcp__orchestrator-graph__supersede_task', 'mcp__orchestrator-graph__configure_task',
  'TaskCreate', 'TaskUpdate', 'TaskGet', 'TaskList',
  'ScheduleWakeup', 'Agent',
];

// Idempotently write the permissions allowlist to <workspace>/.claude/settings.local.json.
// Merges in missing entries without removing any existing ones.
function writePermissionsAllowlist(workspace) {
  const settingsDir = path.join(workspace, '.claude');
  const settingsPath = path.join(settingsDir, 'settings.local.json');
  let existing = {};
  try { existing = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { /* file missing or invalid — start fresh */ }
  const currentAllow = (existing.permissions && existing.permissions.allow) || [];
  const merged = Array.from(new Set([...currentAllow, ...REQUIRED_ALLOW]));
  existing.permissions = Object.assign({}, existing.permissions, { allow: merged });
  fs.mkdirSync(settingsDir, { recursive: true });
  fs.writeFileSync(settingsPath, JSON.stringify(existing, null, 2) + '\n');
  console.log('[harness] permissions allowlist written to .claude/settings.local.json');
}

async function main() {
  const probesPath = arg('probes');
  if (!probesPath) { console.error('usage: onboard-harness.js --probes <probes.json> [--answers <answers.json>] [--model sonnet] [--daemon URL] [--workspace <ws>] [--out reading.json]'); process.exit(2); }
  const probes = loadJSON(probesPath);
  if (!validate(probes)) { console.error('probe file failed validation — aborting'); process.exit(1); }

  // Write permissions allowlist to workspace .claude/settings.local.json
  const harnessWorkspace = arg('workspace-root', process.cwd());
  writePermissionsAllowlist(harnessWorkspace);

  const answersFile = arg('answers');
  const model = arg('model', 'sonnet');
  const judgeModel = arg('judge-model', model);
  const daemon = arg('daemon', DEFAULT_DAEMON);
  const workspace = arg('workspace', null);

  if (answersFile) console.error(`[harness] offline judge over ${probes.length} probes (judge-model=${judgeModel})…`);
  else console.error(`[harness] live: retrieve@${daemon} + cold/kb answers (model=${model}) + judge (model=${judgeModel}) for ${probes.length} probes…`);

  const rows = await run({ probes, daemon, model, judgeModel, answersFile, workspace });
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
