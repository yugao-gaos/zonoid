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
 *
 * QUEUE-BASED BATCH MODE (for large repos with thousands of candidates):
 *   node scripts/onboard-learn.js --repo <abs> --enqueue           # assemble ALL candidates, write queue file. No LLM.
 *   node scripts/onboard-learn.js --repo <abs> --drain [--batch 50] # process next batch from queue via LLM.
 *   node scripts/onboard-learn.js --repo <abs> --queue-status       # print queue progress as JSON.
 *
 * When --drain completes (cursor === total), writes onboard-notes.json automatically.
 * Call --drain repeatedly until --queue-status shows done:true, then --inject --confirm as usual.
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

// Atomic write: write to a temp file then rename so readers never see a partial file.
function writeJSONAtomic(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
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
  const assets = loadJSON(path.join(inDir, 'asset-notes.json'), []);
  const struct = loadJSON(path.join(inDir, 'structure.json'), { nodes: [] });
  const out = [];
  for (const n of git) out.push({ title: n.title, summary: n.summary, kind: n.kind, _origin: 'git', source: n.source });
  for (const n of docs) out.push({ title: n.title, summary: n.summary, kind: n.kind, _origin: 'doc', source: n.source });
  // Config-default candidates (shipped defaults: escalation triggers, timeouts, thresholds, …) —
  // these encode non-obvious "what does it do out of the box" knowledge that lives only in code.
  for (const n of cfg) out.push({ title: n.title, summary: n.summary, kind: n.kind, _origin: 'config', source: n.source });
  // Asset candidates (inventory/conventions, size outliers, churn rationale, orphan refs) —
  // binary assets are the domain where reading code recovers the least semantics.
  for (const n of assets) out.push({ title: n.title, summary: n.summary, kind: n.kind, _origin: 'asset', source: n.source });
  // Structural nodes carry the module-role map; pass a compact form so the agent knows the layout
  // without drowning in 1-per-file noise.
  for (const n of (struct.nodes || [])) out.push({ title: n.id, summary: n.role, kind: 'structure', _origin: 'struct', source: 'structure.json' });
  return out;
}

// Sort candidates by origin priority: config > asset > doc > git > struct.
// Within an origin, original order is preserved (stable sort via index).
function sortByPriority(cands) {
  const prio = { config: 0, asset: 1, doc: 2, git: 3, struct: 4 };
  return cands.map((c, i) => ({ c, i }))
    .sort((a, b) => ((prio[a.c._origin] ?? 9) - (prio[b.c._origin] ?? 9)) || (a.i - b.i))
    .map((x) => x.c);
}

// Cap the candidate list so a large real-world repo can't blow the learner prompt past the model
// context. (Observed on a 2.7k-commit / 1k-file TS app: 2385 candidates ≈ 600KB prompt — the agent
// run fails outright. The self-repo mines ~230, so the default cap is a no-op there.)
// Priority by origin: config/asset (rare, high-signal) > doc > git (log order = newest first) >
// struct (mostly layout context). Within an origin, original order is preserved.
// NOTE: --max-candidates is an emergency ceiling, NOT a batch control. Use --enqueue/--drain for
// proper batching over large candidate sets.
function capCandidates(cands, max) {
  if (!isFinite(max) || cands.length <= max) return cands;
  const sorted = sortByPriority(cands);
  const out = sorted.slice(0, max);
  console.error(`[learn] WARN: capped ${cands.length} mined candidates to ${max} (--max-candidates) by origin priority config>asset>doc>git>struct.`);
  return out;
}

// ---- queue file helpers -----------------------------------------------------------------------

// Queue schema: { total, cursor, kept, rejected, pending }
// pending: all raw candidates sorted by priority (not yet processed).
// cursor: how many of pending have been processed.
// kept/rejected: accumulate LLM validation results.
function readQueue(queueFilePath) {
  return loadJSON(queueFilePath, null);
}

function queueFilePath(outDir) {
  return path.join(outDir, 'onboard-queue.json');
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
  // Persist the agent transcript so a failed run is diagnosable. (A foreign-repo run surfaced an
  // invisible-failure mode: agent exit 1 with ALL output discarded — nothing to debug from.)
  const logFile = path.join(path.dirname(outFile), 'onboard-learn-agent.log');
  try { fs.writeFileSync(logFile, (run.stdout || '') + (run.stderr ? '\n--- stderr ---\n' + run.stderr : '')); } catch { /* best-effort */ }
  if (run.status !== 0) {
    const tail = ((run.stdout || '') + '\n' + (run.stderr || '')).trim().split('\n').slice(-4).join('\n');
    console.error(`[learn] agent FAILED — output tail:\n${tail.slice(-1500)}`);
    console.error(`[learn] full transcript: ${logFile}`);
  }
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
// `workspace` (--workspace): target overlay workspace for the notes. Defaults to the daemon's LIVE
// workspace (back-compat). For a FOREIGN repo's KB, pass an isolated workspace (e.g. the repo path)
// so its notes never land in — and can't pollute — the live graph (note nodes have no delete API).
async function inject(notesFile, confirm, workspace) {
  const data = loadJSON(notesFile, null);
  if (!data || !Array.isArray(data.kept)) {
    console.error(`No validated notes at ${notesFile}. Run the learn pass first.`); process.exit(1);
  }
  const kept = data.kept;
  if (!confirm) {
    console.log('=== onboard-learn --inject DRY RUN (no --confirm) ===');
    console.log(`daemon target: ${DAEMON}${workspace ? ` (workspace ${workspace})` : ''}`);
    console.log(`WOULD CREATE ${kept.length} note nodes (each title prefixed '${PREFIX}').`);
    kept.slice(0, 8).forEach((n, i) => console.log(`  ${i + 1}. [${n.kind}] ${PREFIX}${n.title}`));
    console.log('\nNo network calls were made. Re-run with --confirm to inject.');
    return;
  }
  console.log('=== onboard-learn --inject CONFIRMED ===');
  const existing = new Set();
  if (workspace) {
    // /state reflects only the live workspace; for a foreign workspace there is no cheap exhaustive
    // listing, so dedupe is skipped (re-running inject may duplicate notes there).
    console.error(`WARN: --workspace ${workspace}: /state dedupe unavailable for a non-live workspace; skipping skip-set.`);
  } else {
    try {
      const state = await request('GET', '/state');
      for (const t of state.tasks || []) if (typeof t.label === 'string' && t.label.startsWith(PREFIX)) existing.add(t.label);
    } catch (e) { console.error(`WARN: could not read /state (${e.message}); proceeding without skip-set.`); }
  }
  let created = 0, skipped = 0;
  for (const n of kept) {
    const title = PREFIX + n.title;
    if (existing.has(title)) { skipped++; continue; }
    await request('POST', '/overlay/note', {
      title, summary: n.summary,
      knowledge: [`evidence:${n.evidence || '?'}`, `kind:${n.kind}`, `origin:onboard-learn`],
      created_by: 'onboard-learn',
      ...(workspace ? { workspace } : {}),
    });
    created++;
  }
  console.log(`notes created: ${created}, skipped (already present): ${skipped}`);
  console.log(`Reversible: every injected node is titled '${PREFIX}…' — filter/remove like other ingest nodes.`);
}

// ---- --enqueue: assemble all candidates and write queue file (no LLM) ----------------------
function enqueue(inDir, outDir) {
  let candidates = gatherCandidates(inDir);
  if (!candidates.length) {
    console.error(`No mined candidates in ${inDir}. Run scripts/onboard-mine-*.js --repo <abs> first.`);
    process.exit(1);
  }
  // Sort by priority (config > asset > doc > git > struct). No cap at enqueue time.
  candidates = sortByPriority(candidates);
  fs.mkdirSync(outDir, { recursive: true });
  const queue = { total: candidates.length, cursor: 0, kept: [], rejected: [], pending: candidates };
  writeJSONAtomic(queueFilePath(outDir), queue);
  console.error(`[learn] enqueue: ${candidates.length} candidates written to ${queueFilePath(outDir)}`);
  console.error(`[learn] Run --drain --batch 50 (repeat) until --queue-status shows done:true, then --inject --confirm.`);
}

// ---- --drain: process next batch from queue file via LLM ------------------------------------
// Safe to call repeatedly. Idempotent if cursor === total.
function drain(repoAbs, outDir, model, maxKeep, batchSize, maxCandidates) {
  const qf = queueFilePath(outDir);
  const queue = readQueue(qf);
  if (!queue) {
    console.error(`[learn] No queue file at ${qf}. Run --enqueue first.`);
    process.exit(1);
  }
  if (queue.cursor >= queue.total) {
    console.log(JSON.stringify({ status: 'already_drained', total: queue.total, kept: queue.kept.length }));
    process.exit(0);
  }

  // Apply emergency cap: never send more than maxCandidates in a single drain batch.
  const effectiveBatch = Math.min(batchSize, maxCandidates, queue.total - queue.cursor);
  const batch = queue.pending.slice(queue.cursor, queue.cursor + effectiveBatch);

  console.error(`[learn] drain: processing candidates ${queue.cursor}–${queue.cursor + effectiveBatch - 1} of ${queue.total} (batch=${effectiveBatch})`);

  // Use a temp file for the agent output so we can merge results back into the queue.
  const batchOutFile = path.join(outDir, `onboard-learn-batch-${queue.cursor}.json`);
  // Remove any stale batch file so a failed agent run can't masquerade as success.
  try { fs.unlinkSync(batchOutFile); } catch { /* none */ }

  const status = runLearner(repoAbs, batch, batchOutFile, model, maxKeep);
  const result = loadJSON(batchOutFile, null);
  if (!result || !Array.isArray(result.kept)) {
    console.error(`[learn] FAILED: agent did not produce a valid ${batchOutFile} (exit=${status}).`);
    process.exit(1);
  }

  // Merge results back into queue and advance cursor.
  queue.kept = queue.kept.concat(result.kept || []);
  queue.rejected = queue.rejected.concat(result.rejected || []);
  queue.cursor += effectiveBatch;

  // Write queue back atomically.
  writeJSONAtomic(qf, queue);

  const notesFile = path.join(outDir, 'onboard-notes.json');
  if (queue.cursor >= queue.total) {
    // Queue is drained — write final onboard-notes.json in the same format as the single-pass mode.
    writeJSONAtomic(notesFile, { kept: queue.kept, rejected: queue.rejected });
    fs.writeFileSync(path.join(outDir, 'onboard-learn-report.json'),
      JSON.stringify({ repo: repoAbs, candidates: queue.total, kept: queue.kept.length, rejected: queue.rejected.length, model, queue_mode: true }, null, 2) + '\n');
    console.error(`[learn] DRAIN COMPLETE: ${queue.total} candidates -> kept ${queue.kept.length}, rejected ${queue.rejected.length}. Wrote ${notesFile}`);
    console.error('[learn] Review onboard-notes.json, then: node scripts/onboard-learn.js --repo <abs> --inject [--confirm]');
  } else {
    const remaining = queue.total - queue.cursor;
    console.error(`[learn] drain batch done: cursor=${queue.cursor}/${queue.total}, remaining=${remaining}. kept_so_far=${queue.kept.length}. Run --drain again.`);
  }
}

// ---- --queue-status: print progress JSON without any LLM call ------------------------------
function queueStatus(outDir) {
  const qf = queueFilePath(outDir);
  const queue = readQueue(qf);
  if (!queue) {
    console.error(`[learn] No queue file at ${qf}. Run --enqueue first.`);
    process.exit(1);
  }
  const processed = queue.cursor;
  const remaining = queue.total - queue.cursor;
  const done = queue.cursor >= queue.total;
  console.log(JSON.stringify({ total: queue.total, processed, kept: queue.kept.length, remaining, done }));
}

// ---- main ----------------------------------------------------------------------------------
(async () => {
  const repo = arg('repo');
  if (!repo || !fs.existsSync(repo)) {
    console.error('usage: onboard-learn.js --repo <abs> [--in <onboard-dir>] [--max-candidates N] [--inject [--confirm] [--workspace <ws>]]');
    console.error('       onboard-learn.js --repo <abs> --enqueue');
    console.error('       onboard-learn.js --repo <abs> --drain [--batch 50] [--max-candidates N]');
    console.error('       onboard-learn.js --repo <abs> --queue-status');
    process.exit(2);
  }
  const repoAbs = path.resolve(repo);
  const inDir = path.resolve(arg('in', path.join(repoAbs, '.graph', 'onboard')));
  const outDir = inDir; // output always co-located with input
  const notesFile = path.join(inDir, 'onboard-notes.json');

  if (has('inject')) { await inject(notesFile, has('confirm'), arg('workspace', repoAbs)); return; }

  if (has('queue-status')) { queueStatus(outDir); return; }

  if (has('enqueue')) { enqueue(inDir, outDir); return; }

  if (has('drain')) {
    const batchSize = Math.max(1, parseInt(arg('batch', '50'), 10) || 50);
    // --max-candidates is an emergency ceiling here (safety valve inside a drain batch only).
    const maxCandidates = parseInt(arg('max-candidates', String(Infinity)), 10) || Infinity;
    const model = arg('model', 'opus');
    const maxKeep = parseInt(arg('max-keep', '20'), 10) || 20;
    fs.mkdirSync(outDir, { recursive: true });
    drain(repoAbs, outDir, model, maxKeep, batchSize, maxCandidates);
    return;
  }

  // ---- original single-pass mode (backward compatible) ----------------------------------------
  let candidates = gatherCandidates(inDir);
  if (!candidates.length) {
    console.error(`No mined candidates in ${inDir}. Run scripts/onboard-mine-*.js --repo ${repoAbs} first.`);
    process.exit(1);
  }
  // --max-candidates: emergency cap in single-pass mode (default 500 for backward compat).
  candidates = capCandidates(candidates, parseInt(arg('max-candidates', '500'), 10) || 500);
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
