#!/usr/bin/env node
'use strict';
/**
 * onboard-learn.js — AGENTIC project learner. Turns the cheap static mine (task /7) into a
 * validated, NON-OBVIOUS semantic KB by putting an LLM agent in front of the actual source.
 *
 * The static miners are recall-leaning and noisy (e.g. 137 doc "candidates" for this repo, most
 * of them restatements). This learner runs a headless `claude -p` agent that, with READ access to
 * the target repo, must:
 *   1. read code to VALIDATE or REFUTE each mined hypothesis against what the source actually does,
 *   2. KEEP only NON-OBVIOUS, load-bearing knowledge — a convention, an invariant, the gotcha
 *      behind a revert, a "why X not Y" — that a competent dev would NOT infer in 30s of reading,
 *   3. explicitly REJECT restatements of current code (a note that just narrates a function adds
 *      nothing), and MAY ADD a few high-value notes it discovered while reading that the miners
 *      missed.
 * It writes onboard-notes.json (validated) + onboard-learn-report.json (kept/rejected w/ reasons).
 *
 * DRY-RUN BY DEFAULT and REVERSIBLE: the agent only WRITES A JSON FILE (read-only on the graph).
 * Injection into the live graph is a SEPARATE, explicit --confirm step that reuses the existing
 * reversible '[ingest]' overlay-note path (POST /overlay/note), so every injected node stays
 * filterable/removable exactly like bench/ingest/inject.js's nodes.
 *
 *   node scripts/onboard-learn.js --repo <abs> [--in <onboard-dir>] [--model opus] [--max-keep 20]
 *        # mine-inputs -> agentic validation -> writes onboard-notes.json  (NO graph mutation)
 *   node scripts/onboard-learn.js --repo <abs> --inject          # dry-run injection plan (no mutation)
 *   node scripts/onboard-learn.js --repo <abs> --inject --confirm # perform reversible injection
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const crypto = require('crypto');

const SELF_REPO = path.resolve(__dirname, '..');
const CLAUDE = '/opt/homebrew/bin/claude';
const DAEMON = process.env.ORCH_DAEMON || 'http://localhost:8787';
const PREFIX = '[ingest] '; // reuse the existing reversible prefix so injected nodes stay uniform
const TIMEOUT_S = 600;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes('--' + name);

function loadJSON(p, def) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return def; }
}

// ---- the agent's instruction: validate hypotheses, keep only non-obvious notes -------------
function buildPrompt(repoAbs, candidates, outFile, maxKeep) {
  return `You are ONBOARDING onto an unfamiliar codebase at ${repoAbs}. Your job is to build a
small, HIGH-VALUE knowledge base of NON-OBVIOUS facts about THIS project — the kind of thing a
new engineer only learns after weeks, or by getting burned.

You have Read, Grep/Glob, and Bash (read-only: git log, cat, grep, ls — do NOT modify files).

Below are ${candidates.length} CANDIDATE hypotheses auto-mined from this repo's git history, docs,
and module structure. They are NOISY — many are restatements of what the code obviously does, or
generic boilerplate. Treat each as a hypothesis to VERIFY against the actual source.

For EACH candidate decide KEEP or REJECT. Judge "obvious" from the standpoint of an engineer who
does NOT have the repo in front of them (no file access, no search) — that is who an onboarding KB
actually serves. A fact is OBVIOUS only if such an engineer could reconstruct it from general
knowledge; it is NOT obvious merely because it is plain to read ONCE you have already found the
right line.
- KEEP if it is (a) TRUE (you verified it against code/history) AND (b) NON-RECOVERABLE without the
  repo — a convention, invariant, ordering constraint, cross-module coupling, the reason behind a
  revert/fix, OR a SHIPPED DEFAULT/CONFIG VALUE this project specifically chose (the exact set of
  default escalation triggers, a timeout, a threshold, a protocol version, a weight). Concrete
  project-specific defaults and enumerated sets are KEEP-worthy: an off-repo engineer cannot guess
  them, and "it's obvious from the line" does NOT disqualify them (they only had the line because
  they had the repo). When you keep a config default, record the ACTUAL value/enumeration, not a
  paraphrase ("ships five default escalation triggers: X, Y, Z, …").
- REJECT if it merely restates what a function/file does at a level an off-repo engineer would
  already assume, is generic advice, is stale (no longer true in current code), or you cannot
  confirm it. Restatements of general SWE knowledge are WORSE than nothing.
You MAY also ADD up to 5 NEW notes you discovered while reading that the miners missed and that
clear the same NON-RECOVERABLE bar.

Keep AT MOST ${maxKeep} notes total. Quality over coverage — a KB of restatements is a failure.

When done, write a JSON file to ${outFile} with EXACTLY this shape (no prose around it):
{
  "kept": [
    { "title": "<=80 char imperative/declarative", "summary": "1-3 sentences, the load-bearing fact + WHY it matters", "evidence": "file:line or commit sha you verified against", "kind": "convention|invariant|gotcha|decision", "source": "<candidate index or 'discovered'>" }
  ],
  "rejected": [
    { "candidate": "<short id/title>", "reason": "restatement | stale | unverifiable | generic" }
  ]
}
Write the file with the Write tool. Do not create any other files. Do not touch the orchestrator graph.

=== CANDIDATES (index: [kind] title — summary) ===
${candidates.map((c, i) => `${i}: [${c.kind}] ${c.title} — ${c.summary}`).join('\n')}
`;
}

// ---- gather mined candidates from the onboard dir ------------------------------------------
function gatherCandidates(inDir) {
  const git = loadJSON(path.join(inDir, 'git-notes.json'), []);
  const docs = loadJSON(path.join(inDir, 'doc-notes.json'), []);
  const cfg = loadJSON(path.join(inDir, 'config-notes.json'), []);
  const struct = loadJSON(path.join(inDir, 'structure.json'), { nodes: [] });
  const out = [];
  for (const n of git) out.push({ title: n.title, summary: n.summary, kind: n.kind, _origin: 'git', source: n.source });
  for (const n of docs) out.push({ title: n.title, summary: n.summary, kind: n.kind, _origin: 'doc', source: n.source });
  // Config-default candidates (shipped defaults: escalation triggers, timeouts, thresholds, …) —
  // these encode non-obvious "what does it do out of the box" knowledge that lives only in code.
  for (const n of cfg) out.push({ title: n.title, summary: n.summary, kind: n.kind, _origin: 'config', source: n.source });
  // Structural nodes carry the module-role map; pass a compact form so the agent knows the layout
  // without drowning in 1-per-file noise.
  for (const n of (struct.nodes || [])) out.push({ title: n.id, summary: n.role, kind: 'structure', _origin: 'struct', source: 'structure.json' });
  return out;
}

// ---- headless agentic validation pass ------------------------------------------------------
function runLearner(repoAbs, candidates, outFile, model, maxKeep) {
  const prompt = buildPrompt(repoAbs, candidates, outFile, maxKeep);
  const sessionId = crypto.randomUUID();
  // OFF-graph MCP config: the learner must NOT have orchestrator tools (it only writes a JSON
  // file). Reuse the empty mcp-off.json so no graph server is even reachable.
  const mcpConfig = path.join(SELF_REPO, 'bench', 'mcp-off.json');
  const args = [
    '-e', `alarm ${TIMEOUT_S}; exec @ARGV`, '--',
    CLAUDE, '-p', prompt,
    '--mcp-config', mcpConfig, '--strict-mcp-config',
    '--session-id', sessionId,
    '--model', model,
    '--output-format', 'stream-json', '--verbose',
    '--dangerously-skip-permissions',
    '--add-dir', repoAbs,
    '--add-dir', path.dirname(outFile),
  ];
  console.error(`[learn] running agentic validation (model=${model}, ${candidates.length} candidates)…`);
  const t0 = Date.now();
  const run = spawnSync('perl', args, { cwd: repoAbs, encoding: 'utf8', maxBuffer: 128 * 1024 * 1024 });
  console.error(`[learn] agent finished in ${Math.round((Date.now() - t0) / 1000)}s exit=${run.status}`);
  return run.status;
}

// ---- http (for --inject) -------------------------------------------------------------------
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, DAEMON);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(u, {
      method,
      headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {},
    }, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        let json; try { json = data ? JSON.parse(data) : {}; } catch { json = { raw: data }; }
        if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
        else reject(new Error(`${method} ${urlPath} -> ${res.statusCode}: ${data}`));
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// ---- reversible injection (mirrors bench/ingest/inject.js) ----------------------------------
async function inject(notesFile, confirm) {
  const data = loadJSON(notesFile, null);
  if (!data || !Array.isArray(data.kept)) {
    console.error(`No validated notes at ${notesFile}. Run the learn pass first.`); process.exit(1);
  }
  const kept = data.kept;
  if (!confirm) {
    console.log('=== onboard-learn --inject DRY RUN (no --confirm) ===');
    console.log(`daemon target: ${DAEMON}`);
    console.log(`WOULD CREATE ${kept.length} note nodes (each title prefixed '${PREFIX}').`);
    kept.slice(0, 8).forEach((n, i) => console.log(`  ${i + 1}. [${n.kind}] ${PREFIX}${n.title}`));
    console.log('\nNo network calls were made. Re-run with --confirm to inject.');
    return;
  }
  console.log('=== onboard-learn --inject CONFIRMED ===');
  const existing = new Set();
  try {
    const state = await request('GET', '/state');
    for (const t of state.tasks || []) if (typeof t.label === 'string' && t.label.startsWith(PREFIX)) existing.add(t.label);
  } catch (e) { console.error(`WARN: could not read /state (${e.message}); proceeding without skip-set.`); }
  let created = 0, skipped = 0;
  for (const n of kept) {
    const title = PREFIX + n.title;
    if (existing.has(title)) { skipped++; continue; }
    await request('POST', '/overlay/note', {
      title, summary: n.summary,
      knowledge: [`evidence:${n.evidence || '?'}`, `kind:${n.kind}`, `origin:onboard-learn`],
      created_by: 'onboard-learn',
    });
    created++;
  }
  console.log(`notes created: ${created}, skipped (already present): ${skipped}`);
  console.log(`Reversible: every injected node is titled '${PREFIX}…' — filter/remove like other ingest nodes.`);
}

// ---- main ----------------------------------------------------------------------------------
(async () => {
  const repo = arg('repo');
  if (!repo || !fs.existsSync(repo)) {
    console.error('usage: onboard-learn.js --repo <abs> [--in <onboard-dir>] [--inject [--confirm]]');
    process.exit(2);
  }
  const repoAbs = path.resolve(repo);
  const inDir = path.resolve(arg('in', path.join(SELF_REPO, 'bench', 'onboard', path.basename(repoAbs))));
  const notesFile = path.join(inDir, 'onboard-notes.json');

  if (has('inject')) { await inject(notesFile, has('confirm')); return; }

  const candidates = gatherCandidates(inDir);
  if (!candidates.length) {
    console.error(`No mined candidates in ${inDir}. Run scripts/onboard-mine-*.js --repo ${repoAbs} first.`);
    process.exit(1);
  }
  const model = arg('model', 'opus');
  const maxKeep = parseInt(arg('max-keep', '20'), 10) || 20;
  fs.mkdirSync(inDir, { recursive: true });
  // Remove any stale notes file so a failed/empty agent run can't masquerade as success.
  try { fs.unlinkSync(notesFile); } catch { /* none */ }

  const status = runLearner(repoAbs, candidates, notesFile, model, maxKeep);
  const result = loadJSON(notesFile, null);
  if (!result || !Array.isArray(result.kept)) {
    console.error(`[learn] FAILED: agent did not produce a valid ${notesFile} (exit=${status}).`);
    process.exit(1);
  }
  // Write a small report alongside for review.
  fs.writeFileSync(path.join(inDir, 'onboard-learn-report.json'),
    JSON.stringify({ repo: repoAbs, candidates: candidates.length, kept: result.kept.length, rejected: (result.rejected || []).length, model }, null, 2) + '\n');
  console.error(`[learn] DONE: ${candidates.length} candidates -> kept ${result.kept.length}, rejected ${(result.rejected || []).length}. Wrote ${notesFile}`);
  console.error('[learn] Review onboard-notes.json, then: node scripts/onboard-learn.js --repo <abs> --inject [--confirm]');
})();
