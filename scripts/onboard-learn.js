#!/usr/bin/env node
'use strict';
/**
 * onboard-learn.js — AGENTIC project learner. Turns the cheap static mine (task /7) into a
 * validated, NON-OBVIOUS semantic KB by putting a bounded LLM judge in front of mined evidence.
 *
 * The static miners are recall-leaning and noisy (e.g. 137 doc "candidates" for this repo, most
 * of them restatements). This learner runs the dashboard-selected agentic CLI backend against
 * compact evidence snippets so it must:
 *   1. VALIDATE or REFUTE each mined hypothesis against bounded evidence prepared by this script,
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
 *   node scripts/onboard-learn.js --repo <abs> [--in <onboard-dir>] [--model <backend-model>] [--max-keep 20]
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

const { execFileSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const http = require('http');
const os = require('os');

const SELF_REPO = path.resolve(__dirname, '..');
const backendLib = require('../lib/llm-backend');
const overlayStore = require('../lib/overlay');
// Load secrets from a gitignored .env.local (then .env) at the repo root into process.env without
// overriding the real environment. Individual backend providers decide which credentials matter.
try { require('../lib/load-env').loadEnvFiles(SELF_REPO); } catch { /* optional */ }

// Empty MCP config so the spawned learner has NO orchestrator tools (it only writes a JSON file).
// Generated in an OS temp file at runtime — NOT read from a repo path. The old source was
// `bench/mcp-off.json`, a dev-only benchmark fixture the npm package excludes (files-whitelist +
// .npmignore), so depending on it broke onboarding in installed copies. The content is constant.
const MCP_OFF = (() => {
  const p = path.join(os.tmpdir(), `zonoid-mcp-off-${process.pid}.json`);
  fs.writeFileSync(p, '{"mcpServers":{}}');
  return p;
})();
const DAEMON = process.env.ORCH_DAEMON || 'http://localhost:8787';
const PREFIX = '[ingest] '; // reuse the existing reversible prefix so injected nodes stay uniform
const DEFAULT_TIMEOUT_MS = 600 * 1000;
const QUEUE_LOCK_STALE_MS = 30 * 1000;
const QUEUE_LOCK_WAIT_MS = 5000;
const EXIT_TIMEOUT = 124;
const EVIDENCE_LINE_RADIUS = 4;
const MAX_EVIDENCE_CHARS = 1400;
const MAX_FILE_EVIDENCE_BYTES = 256 * 1024;

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}
const has = (name) => process.argv.includes('--' + name);

function loadJSON(p, def) {
  // Strip a leading UTF-8 BOM before parsing: the agent's Write tool can emit one on Windows,
  // and JSON.parse rejects a BOM ("Unexpected token"). Harmless on already-clean files.
  try { return JSON.parse(fs.readFileSync(p, 'utf8').replace(/^\uFEFF/, '')); } catch { return def; }
}

function normalizeSourcePath(s) {
  return String(s || '').replace(/\\/g, '/').replace(/:\d+(?::\d+)?$/, '');
}

// Atomic write: write to a temp file then rename so readers never see a partial file.
function writeJSONAtomic(filePath, data) {
  const tmp = filePath + '.tmp.' + process.pid;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n');
  fs.renameSync(tmp, filePath);
}

function truncateText(s, max = MAX_EVIDENCE_CHARS) {
  const text = String(s || '').trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 24)).trimEnd()}\n[truncated to ${max} chars]`;
}

function parseSourceLine(source) {
  const m = String(source || '').match(/^(.+?):(\d+)(?::\d+)?$/);
  if (!m) return null;
  return { rel: normalizeSourcePath(m[1]), line: Math.max(1, Number(m[2]) || 1) };
}

function isGitSha(source) {
  return /^[0-9a-f]{7,40}$/i.test(String(source || '').trim());
}

function safeRepoFile(repoAbs, rel) {
  const abs = path.resolve(repoAbs, rel || '');
  const root = path.resolve(repoAbs);
  if (abs !== root && !abs.startsWith(root + path.sep)) return null;
  return abs;
}

function excerptAroundLine(text, line, radius = EVIDENCE_LINE_RADIUS) {
  const lines = String(text || '').split(/\r?\n/);
  const idx = Math.max(0, Math.min(lines.length - 1, (Number(line) || 1) - 1));
  const start = Math.max(0, idx - radius);
  const end = Math.min(lines.length, idx + radius + 1);
  return lines.slice(start, end).map((value, offset) => {
    const n = start + offset + 1;
    return `${n}: ${value.slice(0, 240)}`;
  }).join('\n');
}

function excerptAroundNeedle(text, needle) {
  const body = String(text || '');
  const trimmedNeedle = String(needle || '').trim();
  if (!trimmedNeedle) return '';
  const lines = body.split(/\r?\n/);
  const needleLower = trimmedNeedle.toLowerCase();
  let idx = lines.findIndex((line) => line.toLowerCase().includes(needleLower));
  if (idx < 0) {
    const tokens = Array.from(tokenSet(trimmedNeedle)).slice(0, 5);
    idx = lines.findIndex((line) => tokens.length && tokens.every((t) => line.toLowerCase().includes(t)));
  }
  if (idx < 0) return '';
  return excerptAroundLine(body, idx + 1, EVIDENCE_LINE_RADIUS);
}

function fileEvidence(repoAbs, candidate) {
  const source = String(candidate && candidate.source || '').trim();
  const parsed = parseSourceLine(source);
  const rel = parsed ? parsed.rel : normalizeSourcePath(source);
  if (!rel || rel.startsWith('asset-scan') || rel.startsWith('asset-ref-scan')) return '';
  const abs = safeRepoFile(repoAbs, rel);
  if (!abs) return '';
  let stat;
  try { stat = fs.statSync(abs); } catch { return ''; }
  if (!stat.isFile()) return '';
  if (stat.size > MAX_FILE_EVIDENCE_BYTES) {
    return `${rel}: file exists (${stat.size} bytes); content omitted by learner evidence cap.`;
  }
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8').replace(/^\uFEFF/, ''); } catch { return ''; }
  if (parsed) return `${rel}:${parsed.line}\n${truncateText(excerptAroundLine(text, parsed.line))}`;
  const needle = excerptAroundNeedle(text, candidate.summary) || excerptAroundNeedle(text, candidate.title);
  if (needle) return `${rel}\n${truncateText(needle)}`;
  return `${rel}\n${truncateText(excerptAroundLine(text, 1, 8))}`;
}

function gitEvidence(repoAbs, candidate) {
  const source = String(candidate && candidate.source || '').trim();
  if (!isGitSha(source)) return '';
  try {
    const out = execFileSync('git', [
      '-C', repoAbs,
      'show',
      '--no-ext-diff',
      '--no-color',
      '--stat',
      '--summary',
      '--format=medium',
      source,
    ], { encoding: 'utf8', maxBuffer: 512 * 1024 });
    return truncateText(out);
  } catch {
    return '';
  }
}

function boundedEvidenceForCandidate(repoAbs, candidate) {
  const parts = [
    gitEvidence(repoAbs, candidate),
    fileEvidence(repoAbs, candidate),
  ].filter(Boolean);
  return truncateText(parts.join('\n\n') || 'No bounded evidence beyond the mined title/summary/source.');
}

function boundedCandidatesForPrompt(repoAbs, candidates) {
  return candidates.map((c, i) => ({
    index: i,
    kind: String(c.kind || 'gotcha'),
    origin: String(c._origin || ''),
    title: String(c.title || ''),
    summary: String(c.summary || ''),
    source: String(c.source || ''),
    evidence: boundedEvidenceForCandidate(repoAbs, c),
  }));
}

// ---- the agent's instruction: validate hypotheses, keep only non-obvious notes -------------
function buildPrompt(repoAbs, candidates, outFile, maxKeep) {
  const bounded = boundedCandidatesForPrompt(repoAbs, candidates);
  return `You are ONBOARDING onto an unfamiliar codebase at ${repoAbs}. Your job is to build a
small, HIGH-VALUE knowledge base of NON-OBVIOUS facts about THIS project — the kind of thing a
new engineer only learns after weeks, or by getting burned.

This is a BOUNDED learner pass. Do NOT inspect the repo. Do NOT run shell commands. Do NOT use
git, grep, cat, ls, file reads, web access, or any tool to gather more evidence. The bounded
evidence below is the entire record you may judge from. If the evidence does not prove a
candidate, REJECT it as "unverifiable". The only filesystem action you may perform is creating or
overwriting the required JSON output file.

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
Do NOT add discovered notes in this bounded mode; there is no repo exploration. Only keep or
reject the listed candidates.

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
Create or overwrite that JSON file. Do not create any other files. Do not touch the orchestrator graph.

=== BOUNDED CANDIDATES ===
${bounded.map((c) => JSON.stringify(c)).join('\n')}
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

function tokenSet(s) {
  return new Set(String(s || '').toLowerCase().match(/[a-z0-9]{3,}/g) || []);
}

function tokenOverlapScore(a, b) {
  const aa = tokenSet(a);
  if (!aa.size) return 0;
  let score = 0;
  for (const t of tokenSet(b)) if (aa.has(t)) score++;
  return score;
}

function structureNodesForSource(structure, sourcePath) {
  const src = normalizeSourcePath(sourcePath);
  if (!src) return [];
  return (Array.isArray(structure.nodes) ? structure.nodes : [])
    .filter((n) => normalizeSourcePath(n.source_path) === src && n.key);
}

function evidenceRefsForNote(note, candidates, structure) {
  const refs = new Set(Array.isArray(note.evidence_refs) ? note.evidence_refs.filter(Boolean) : []);
  const sourceIndex = Number.parseInt(String(note.source || ''), 10);
  const sourceCandidate = Number.isInteger(sourceIndex) && sourceIndex >= 0 ? candidates[sourceIndex] : null;
  const sourcePaths = [
    sourceCandidate && sourceCandidate.source,
    note.evidence,
  ].map(normalizeSourcePath).filter(Boolean);

  const query = [note.title, note.summary, note.evidence, sourceCandidate && sourceCandidate.summary].filter(Boolean).join(' ');
  for (const sourcePath of sourcePaths) {
    const nodes = structureNodesForSource(structure, sourcePath);
    if (!nodes.length) continue;
    const ranked = nodes.map((n) => ({
      key: n.key,
      type: n.type,
      score: tokenOverlapScore(query, `${n.label || ''} ${n.summary || ''} ${n.section_ref || ''}`),
    })).sort((a, b) => (b.score - a.score) || ((a.type === 'source_chunk' ? 0 : 1) - (b.type === 'source_chunk' ? 0 : 1)));
    const matched = ranked.filter((n) => n.score > 0 && n.type !== 'source_doc').slice(0, 3);
    for (const n of (matched.length ? matched : ranked.filter((n) => n.type === 'source_chunk').slice(0, 3))) refs.add(n.key);
    if (!refs.size) {
      const doc = ranked.find((n) => n.type === 'source_doc') || ranked[0];
      if (doc) refs.add(doc.key);
    }
  }
  return Array.from(refs);
}

function enrichLearnerResultWithEvidenceRefs(result, candidates, inDir) {
  if (!result || !Array.isArray(result.kept)) return result;
  const structure = loadJSON(path.join(inDir, 'doc-structure.json'), { nodes: [], edges: [] });
  const kept = result.kept.map((n) => {
    const refs = evidenceRefsForNote(n, candidates, structure);
    return refs.length ? { ...n, evidence_refs: refs } : n;
  });
  return { ...result, kept };
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

// Queue schema: { total, cursor, kept, rejected, pending, inflight?, completed? }
// pending: all raw candidates sorted by priority (not yet processed).
// cursor: how many of pending have been processed and merged contiguously.
// kept/rejected: accumulate LLM validation results.
// inflight/completed: sparse start-index maps used so several drain children can reserve
// non-overlapping slices and merge them in cursor order.
function readQueue(queueFilePath) {
  return loadJSON(queueFilePath, null);
}

function queueFilePath(outDir) {
  return path.join(outDir, 'onboard-queue.json');
}

function sleepSync(ms) {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

function isPidAlive(pid) {
  const n = Number(pid);
  if (!Number.isInteger(n) || n <= 0) return false;
  try {
    process.kill(n, 0);
    return true;
  } catch (err) {
    return !!(err && err.code === 'EPERM');
  }
}

function withQueueLock(qf, fn) {
  const lock = `${qf}.lock`;
  fs.mkdirSync(path.dirname(qf), { recursive: true });
  const deadline = Date.now() + QUEUE_LOCK_WAIT_MS;
  let fd = null;
  while (fd == null) {
    try {
      fd = fs.openSync(lock, 'wx');
      fs.writeFileSync(fd, JSON.stringify({ pid: process.pid, at: Date.now() }));
    } catch (err) {
      if (!err || err.code !== 'EEXIST') throw err;
      try {
        const st = fs.statSync(lock);
        if (Date.now() - st.mtimeMs > QUEUE_LOCK_STALE_MS) {
          fs.unlinkSync(lock);
          continue;
        }
      } catch { /* lock disappeared; retry */ }
      if (Date.now() >= deadline) throw new Error(`timed out waiting for queue lock ${lock}`);
      sleepSync(50);
    }
  }
  try {
    return fn();
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
    try { fs.unlinkSync(lock); } catch { /* ignore */ }
  }
}

function normalizeQueue(queue) {
  if (!queue || typeof queue !== 'object') return null;
  queue.total = Number(queue.total) || 0;
  queue.cursor = Math.max(0, Number(queue.cursor) || 0);
  if (!Array.isArray(queue.kept)) queue.kept = [];
  if (!Array.isArray(queue.rejected)) queue.rejected = [];
  if (!Array.isArray(queue.pending)) queue.pending = [];
  if (!queue.inflight || typeof queue.inflight !== 'object' || Array.isArray(queue.inflight)) queue.inflight = {};
  if (!queue.completed || typeof queue.completed !== 'object' || Array.isArray(queue.completed)) queue.completed = {};
  return queue;
}

function cleanupExpiredInflight(queue, nowMs = Date.now()) {
  normalizeQueue(queue);
  for (const [start, entry] of Object.entries(queue.inflight || {})) {
    const expired = entry && entry.expiresAt && Number(entry.expiresAt) <= nowMs;
    const deadOwner = entry && entry.pid && !isPidAlive(entry.pid);
    if (!entry || expired || deadOwner) delete queue.inflight[start];
  }
}

function flushCompleted(queue) {
  normalizeQueue(queue);
  let flushed = false;
  while (queue.cursor < queue.total) {
    const key = String(queue.cursor);
    const done = queue.completed[key];
    if (!done) break;
    queue.kept = queue.kept.concat(Array.isArray(done.kept) ? done.kept : []);
    queue.rejected = queue.rejected.concat(Array.isArray(done.rejected) ? done.rejected : []);
    queue.cursor += Math.max(0, Number(done.count) || 0);
    delete queue.completed[key];
    flushed = true;
  }
  return flushed;
}

function coveredIntervalAt(queue, index) {
  for (const source of [queue.completed || {}, queue.inflight || {}]) {
    for (const [startKey, entry] of Object.entries(source)) {
      const start = Number(startKey);
      const count = Math.max(0, Number(entry && entry.count) || 0);
      if (Number.isFinite(start) && count > 0 && index >= start && index < start + count) {
        return { start, end: start + count };
      }
    }
  }
  return null;
}

function reserveQueueBatch(qf, batchSize, maxCandidates, nowMs = Date.now(), reservationTtlMs = DEFAULT_TIMEOUT_MS * 2) {
  return withQueueLock(qf, () => {
    const queue = normalizeQueue(readQueue(qf));
    if (!queue) return { status: 'missing_queue' };
    cleanupExpiredInflight(queue, nowMs);
    flushCompleted(queue);
    if (queue.cursor >= queue.total) {
      writeJSONAtomic(qf, queue);
      return { status: 'already_drained', total: queue.total, kept: queue.kept.length };
    }

    let start = queue.cursor;
    while (start < queue.total) {
      const covered = coveredIntervalAt(queue, start);
      if (!covered) break;
      start = covered.end;
    }
    if (start >= queue.total) {
      writeJSONAtomic(qf, queue);
      return { status: 'all_slices_inflight', total: queue.total, kept: queue.kept.length };
    }

    const count = Math.min(batchSize, maxCandidates, queue.total - start);
    queue.inflight[String(start)] = {
      count,
      pid: process.pid,
      startedAt: nowMs,
      expiresAt: nowMs + Math.max(1000, Number(reservationTtlMs) || DEFAULT_TIMEOUT_MS),
    };
    writeJSONAtomic(qf, queue);
    return {
      status: 'reserved',
      total: queue.total,
      start,
      count,
      batch: queue.pending.slice(start, start + count),
    };
  });
}

function completeQueueBatch(qf, reservation, result, repoAbs, outDir, model) {
  return withQueueLock(qf, () => {
    const queue = normalizeQueue(readQueue(qf));
    if (!queue) throw new Error(`No queue file at ${qf}`);
    cleanupExpiredInflight(queue);
    const key = String(reservation.start);
    delete queue.inflight[key];
    queue.completed[key] = {
      count: reservation.count,
      kept: Array.isArray(result.kept) ? result.kept : [],
      rejected: Array.isArray(result.rejected) ? result.rejected : [],
    };
    flushCompleted(queue);
    writeJSONAtomic(qf, queue);
    const notesFile = path.join(outDir, 'onboard-notes.json');
    writeJSONAtomic(notesFile, { kept: queue.kept, rejected: queue.rejected });
    if (queue.cursor >= queue.total) {
      fs.writeFileSync(path.join(outDir, 'onboard-learn-report.json'),
        JSON.stringify({ repo: repoAbs, candidates: queue.total, kept: queue.kept.length, rejected: queue.rejected.length, model, queue_mode: true }, null, 2) + '\n');
    }
    return queue;
  });
}

function failQueueBatch(qf, reservation) {
  if (!reservation || reservation.status !== 'reserved') return;
  try {
    withQueueLock(qf, () => {
      const queue = normalizeQueue(readQueue(qf));
      if (!queue) return;
      delete queue.inflight[String(reservation.start)];
      writeJSONAtomic(qf, queue);
    });
  } catch { /* best-effort; stale reservations expire */ }
}

function resolveLearnerBackend(repoAbs, requestedModel, deps = {}) {
  const overlays = deps.overlayStore || overlayStore;
  const backends = deps.backendLib || backendLib;
  const overlay = overlays.load ? overlays.load(repoAbs) : {};
  const active = backends.getActiveBackend(overlay);
  const provider = active && active.provider;
  if (!provider) throw new Error('no active LLM backend provider is registered');
  if (provider.kind !== 'agentic-cli') {
    throw new Error(`learner requires an agentic CLI backend; active backend "${provider.id}" is ${provider.kind}`);
  }
  if (typeof provider.isAvailable === 'function' && !provider.isAvailable()) {
    throw new Error(`${provider.displayName || provider.id} CLI is not available`);
  }
  if (typeof provider.isAuthed === 'function' && !provider.isAuthed()) {
    throw new Error(`${provider.displayName || provider.id} is not authenticated for headless use`);
  }
  return { ...active, provider, model: requestedModel || active.model || undefined };
}

function buildLearnerInvocation(repoAbs, candidates, outFile, model, maxKeep, deps = {}) {
  const prompt = buildPrompt(repoAbs, candidates, outFile, maxKeep);
  const outDir = path.dirname(outFile);
  // OFF-graph MCP config: the learner must NOT have orchestrator tools (it only writes a JSON
  // file). MCP_OFF is an empty config generated at runtime so no graph server is even reachable.
  const mcpConfig = MCP_OFF;
  const active = resolveLearnerBackend(repoAbs, model, deps);
  const invocation = active.provider.buildInvocation({
    prompt,
    model: active.model,
    mcpConfig,
    addDir: [outDir],
  });
  return { active, invocation: { ...invocation, cwd: outDir } };
}

function buildLearnerProcessEnv(invocationEnv = {}) {
  const env = { ...process.env, ...(invocationEnv || {}) };
  const pathKey = Object.prototype.hasOwnProperty.call(env, 'Path') && !Object.prototype.hasOwnProperty.call(env, 'PATH')
    ? 'Path'
    : 'PATH';
  const currentPath = String(env[pathKey] || '');
  const pathParts = [
    path.dirname(process.execPath),
    ...(process.platform === 'win32' ? [] : ['/opt/homebrew/bin', '/usr/local/bin', '/usr/bin', '/bin', '/usr/sbin', '/sbin']),
    ...currentPath.split(path.delimiter),
  ].filter(Boolean);
  const seen = new Set();
  env[pathKey] = pathParts.filter((part) => {
    if (seen.has(part)) return false;
    seen.add(part);
    return true;
  }).join(path.delimiter);
  return env;
}

function killTimedOutLearnerProcesses(outFile) {
  if (process.platform === 'win32' || !outFile) return;
  const pattern = String(outFile).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let listing = '';
  try {
    listing = execFileSync('pgrep', ['-f', pattern], { encoding: 'utf8', maxBuffer: 1024 * 1024 });
  } catch {
    return;
  }
  for (const line of listing.split(/\r?\n/)) {
    const pid = Number(line.trim());
    if (!pid || pid === process.pid) continue;
    try { process.kill(pid, 'SIGKILL'); } catch { /* already gone */ }
  }
}

// ---- headless agentic validation pass ------------------------------------------------------
function runLearnerProcess(invocation, repoAbs, timeoutMs) {
  return new Promise((resolve) => {
    const maxBuffer = 128 * 1024 * 1024;
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let spawnError = null;
    const child = spawn(invocation.bin, invocation.args, {
      cwd: invocation.cwd || repoAbs,
      env: buildLearnerProcessEnv(invocation.env),
      detached: process.platform !== 'win32',
      shell: backendLib.needsShell(invocation.bin),
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    });
    const finish = (status, signal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ status, signal, stdout, stderr, error: spawnError, timedOut });
    };
    const killChildTree = () => {
      timedOut = true;
      try {
        if (process.platform !== 'win32' && child.pid) process.kill(-child.pid, 'SIGKILL');
        else child.kill('SIGKILL');
      } catch {
        try { child.kill('SIGKILL'); } catch { /* already gone */ }
      }
    };
    const timer = setTimeout(killChildTree, Math.max(1000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS));
    child.stdout.on('data', (chunk) => { if (stdout.length < maxBuffer) stdout += chunk; });
    child.stderr.on('data', (chunk) => { if (stderr.length < maxBuffer) stderr += chunk; });
    child.on('error', (err) => { spawnError = err; finish(null, null); });
    child.on('close', (code, signal) => finish(code, signal));
  });
}

async function runLearner(repoAbs, candidates, outFile, model, maxKeep, timeoutMs = DEFAULT_TIMEOUT_MS) {
  let active;
  let invocation;
  try {
    ({ active, invocation } = buildLearnerInvocation(repoAbs, candidates, outFile, model, maxKeep));
  } catch (err) {
    console.error(`[learn] FATAL: ${err && err.message ? err.message : err}`);
    return 1;
  }
  const provider = active.provider;
  const effectiveModel = active.model || '(provider default)';
  console.error(`[learn] running agentic validation (provider=${provider.id}, model=${effectiveModel}, ${candidates.length} candidates)…`);
  const t0 = Date.now();
  const run = await runLearnerProcess(invocation, repoAbs, timeoutMs);
  if (run.timedOut) killTimedOutLearnerProcesses(outFile);
  console.error(`[learn] agent finished in ${Math.round((Date.now() - t0) / 1000)}s exit=${run.status}`);
  if (run.error && run.error.code === 'ENOENT') {
    console.error(`[learn] FATAL: ${provider.displayName || provider.id} CLI not found (tried "${invocation.bin}"). Configure the selected backend CLI path.`);
  }
  // Persist the agent transcript so a failed run is diagnosable. (A foreign-repo run surfaced an
  // invisible-failure mode: agent exit 1 with ALL output discarded — nothing to debug from.)
  const logFile = path.join(path.dirname(outFile), 'onboard-learn-agent.log');
  try { fs.writeFileSync(logFile, (run.stdout || '') + (run.stderr ? '\n--- stderr ---\n' + run.stderr : '')); } catch { /* best-effort */ }
  if (run.status !== 0) {
    const tail = ((run.stdout || '') + '\n' + (run.stderr || '')).trim().split('\n').slice(-4).join('\n');
    console.error(`[learn] agent FAILED — output tail:\n${tail.slice(-1500)}`);
    console.error(`[learn] full transcript: ${logFile}`);
  }
  if (run.timedOut || (run.error && run.error.code === 'ETIMEDOUT')) return EXIT_TIMEOUT;
  if (run.error && run.error.code === 'ENOENT') return 127;
  return run.status == null ? 1 : run.status;
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
  return injectOnboardNotes(notesFile, confirm, workspace, request);
}

async function injectOnboardNotes(notesFile, confirm, workspace, httpRequest = request) {
  const data = loadJSON(notesFile, null);
  if (!data || !Array.isArray(data.kept)) {
    console.error(`No validated notes at ${notesFile}. Run the learn pass first.`); process.exit(1);
  }
  const structureFile = path.join(path.dirname(notesFile), 'doc-structure.json');
  const structure = loadJSON(structureFile, { nodes: [], edges: [] });
  const kept = data.kept;
  if (!confirm) {
    console.log('=== onboard-learn --inject DRY RUN (no --confirm) ===');
    console.log(`daemon target: ${DAEMON}${workspace ? ` (workspace ${workspace})` : ''}`);
    console.log(`WOULD UPSERT ${(structure.nodes || []).length} document structure node(s) and ${(structure.edges || []).length} provenance edge(s).`);
    console.log(`WOULD CREATE ${kept.length} note nodes (each title prefixed '${PREFIX}').`);
    kept.slice(0, 8).forEach((n, i) => console.log(`  ${i + 1}. [${n.kind}] ${PREFIX}${n.title}`));
    console.log('\nNo network calls were made. Re-run with --confirm to inject.');
    return;
  }
  console.log('=== onboard-learn --inject CONFIRMED ===');
  const structureResult = await injectDocumentStructure(path.dirname(notesFile), workspace, httpRequest);
  const existing = new Set();
  try {
    const statePath = workspace ? `/state?workspace=${encodeURIComponent(workspace)}` : '/state';
    const state = await httpRequest('GET', statePath);
    for (const t of state.tasks || []) if (typeof t.label === 'string' && t.label.startsWith(PREFIX)) existing.add(t.label);
  } catch (e) { console.error(`WARN: could not read /state for idempotency (${e.message}); proceeding without skip-set.`); }
  let created = 0, skipped = 0, evidenceEdges = 0;
  for (const n of kept) {
    const title = PREFIX + n.title;
    if (existing.has(title)) { skipped++; continue; }
    const noteResp = await httpRequest('POST', '/overlay/note', {
      title, summary: n.summary,
      knowledge: [`evidence:${n.evidence || '?'}`, `kind:${n.kind}`, `origin:onboard-learn`]
        .concat((Array.isArray(n.evidence_refs) ? n.evidence_refs : []).map((ref) => `evidence_ref:${ref}`)),
      created_by: 'onboard-learn',
      ...(workspace ? { workspace } : {}),
    });
    const noteKey = noteResp && (noteResp.key || (noteResp.id ? `note:${noteResp.id}` : null));
    if (noteKey) {
      for (const ref of evidenceRefsForNote(n, [], structure)) {
        await httpRequest('POST', '/overlay/edge', {
          from: ref,
          to: noteKey,
          kind: 'context',
          weight: 1.0,
          ...(workspace ? { workspace } : {}),
        });
        evidenceEdges++;
      }
    }
    created++;
  }
  console.log(`document structure nodes upserted: ${structureResult.nodes}, provenance edges upserted: ${structureResult.edges}`);
  console.log(`notes created: ${created}, skipped (already present): ${skipped}, evidence edges: ${evidenceEdges}`);
  console.log(`Reversible: every injected node is titled '${PREFIX}…' — filter/remove like other ingest nodes.`);
  return { created, skipped, evidenceEdges, structure: structureResult };
}

async function injectDocumentStructure(inDir, workspace, httpRequest = request) {
  const structure = loadJSON(path.join(inDir, 'doc-structure.json'), { nodes: [], edges: [] });
  const nodes = Array.isArray(structure.nodes) ? structure.nodes : [];
  const edges = Array.isArray(structure.edges) ? structure.edges : [];
  let upserted = 0;
  let wired = 0;
  for (const n of nodes) {
    await httpRequest('POST', '/overlay/knowledge-node', {
      ...n,
      ...(workspace ? { workspace } : {}),
    });
    upserted++;
  }
  for (const e of edges) {
    await httpRequest('POST', '/overlay/edge', {
      from: e.from,
      to: e.to,
      kind: e.kind || 'context',
      weight: typeof e.weight === 'number' ? e.weight : 1.0,
      ...(workspace ? { workspace } : {}),
    });
    wired++;
  }
  return { nodes: upserted, edges: wired };
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
async function drain(repoAbs, outDir, model, maxKeep, batchSize, maxCandidates, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const qf = queueFilePath(outDir);
  if (!readQueue(qf)) {
    console.error(`[learn] No queue file at ${qf}. Run --enqueue first.`);
    process.exit(1);
  }

  const reservation = reserveQueueBatch(qf, batchSize, maxCandidates, Date.now(), Math.max(timeoutMs * 2, 10000));
  if (reservation.status === 'already_drained') {
    console.log(JSON.stringify({ status: 'already_drained', total: reservation.total, kept: reservation.kept }));
    process.exit(0);
  }
  if (reservation.status === 'all_slices_inflight') {
    console.log(JSON.stringify({ status: 'all_slices_inflight', total: reservation.total, kept: reservation.kept }));
    process.exit(0);
  }
  if (reservation.status !== 'reserved') {
    console.error(`[learn] No queue file at ${qf}. Run --enqueue first.`);
    process.exit(1);
  }

  const { start, count, batch } = reservation;
  console.error(`[learn] drain: processing candidates ${start}–${start + count - 1} of ${reservation.total} (batch=${count})`);

  // Use a temp file for the agent output so we can merge results back into the queue.
  const batchOutFile = path.join(outDir, `onboard-learn-batch-${start}.json`);
  // Remove any stale batch file so a failed agent run can't masquerade as success.
  try { fs.unlinkSync(batchOutFile); } catch { /* none */ }

  const status = await runLearner(repoAbs, batch, batchOutFile, model, maxKeep, timeoutMs);
  const result = loadJSON(batchOutFile, null);
  if (!result || !Array.isArray(result.kept)) {
    failQueueBatch(qf, reservation);
    console.error(`[learn] FAILED: agent did not produce a valid ${batchOutFile} (exit=${status}).`);
    process.exit(status === EXIT_TIMEOUT ? EXIT_TIMEOUT : 1);
  }
  const enrichedResult = enrichLearnerResultWithEvidenceRefs(result, batch, outDir);

  // Merge results back into queue and advance the contiguous cursor when possible.
  const queue = completeQueueBatch(qf, reservation, enrichedResult, repoAbs, outDir, model);
  const notesFile = path.join(outDir, 'onboard-notes.json');
  if (queue.cursor >= queue.total) {
    console.error(`[learn] DRAIN COMPLETE: ${queue.total} candidates -> kept ${queue.kept.length}, rejected ${queue.rejected.length}. Wrote ${notesFile}`);
    console.error('[learn] Review onboard-notes.json, then: node scripts/onboard-learn.js --repo <abs> --inject [--confirm]');
  } else {
    const remaining = queue.total - queue.cursor;
    console.error(`[learn] drain batch done: cursor=${queue.cursor}/${queue.total}, remaining=${remaining}. kept_so_far=${queue.kept.length}. Run --drain again.`);
  }
}

// ---- --queue-status: print progress JSON without any LLM call ------------------------------
function previewKeptNotes(queue, limit = 64) {
  return (Array.isArray(queue.kept) ? queue.kept : []).slice(0, limit).map((n, i) => ({
    title: String(n && n.title || '').trim() || `Kept note ${i + 1}`,
    summary: String(n && n.summary || '').trim(),
    kind: String(n && n.kind || 'note').trim() || 'note',
  }));
}

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
  console.log(JSON.stringify({ total: queue.total, processed, kept: queue.kept.length, keptNotes: previewKeptNotes(queue), remaining, done }));
}

// ---- main ----------------------------------------------------------------------------------
async function main() {
  const repo = arg('repo');
  if (!repo || !fs.existsSync(repo)) {
    console.error('usage: onboard-learn.js --repo <abs> [--in <onboard-dir>] [--max-candidates N] [--inject [--confirm] [--workspace <ws>]]');
    console.error('       onboard-learn.js --repo <abs> --enqueue');
    console.error('       onboard-learn.js --repo <abs> --drain [--batch 50] [--max-candidates N] [--timeout-ms N]');
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
    const model = arg('model', null);
    const maxKeep = parseInt(arg('max-keep', '20'), 10) || 20;
    const timeoutMs = Math.max(1000, parseInt(arg('timeout-ms', String(DEFAULT_TIMEOUT_MS)), 10) || DEFAULT_TIMEOUT_MS);
    fs.mkdirSync(outDir, { recursive: true });
    await drain(repoAbs, outDir, model, maxKeep, batchSize, maxCandidates, timeoutMs);
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
  const model = arg('model', null);
  const maxKeep = parseInt(arg('max-keep', '20'), 10) || 20;
  fs.mkdirSync(inDir, { recursive: true });
  // Remove any stale notes file so a failed/empty agent run can't masquerade as success.
  try { fs.unlinkSync(notesFile); } catch { /* none */ }

  const timeoutMs = Math.max(1000, parseInt(arg('timeout-ms', String(DEFAULT_TIMEOUT_MS)), 10) || DEFAULT_TIMEOUT_MS);
  const status = await runLearner(repoAbs, candidates, notesFile, model, maxKeep, timeoutMs);
  const result = loadJSON(notesFile, null);
  if (!result || !Array.isArray(result.kept)) {
    console.error(`[learn] FAILED: agent did not produce a valid ${notesFile} (exit=${status}).`);
    process.exit(1);
  }
  const enrichedResult = enrichLearnerResultWithEvidenceRefs(result, candidates, inDir);
  if (enrichedResult !== result) writeJSONAtomic(notesFile, enrichedResult);
  // Write a small report alongside for review.
  fs.writeFileSync(path.join(inDir, 'onboard-learn-report.json'),
    JSON.stringify({ repo: repoAbs, candidates: candidates.length, kept: enrichedResult.kept.length, rejected: (enrichedResult.rejected || []).length, model }, null, 2) + '\n');
  console.error(`[learn] DONE: ${candidates.length} candidates -> kept ${enrichedResult.kept.length}, rejected ${(enrichedResult.rejected || []).length}. Wrote ${notesFile}`);
  console.error('[learn] Review onboard-notes.json, then: node scripts/onboard-learn.js --repo <abs> --inject [--confirm]');
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err && err.stack ? err.stack : err);
    process.exit(1);
  });
}

module.exports = {
  gatherCandidates,
  injectDocumentStructure,
  injectOnboardNotes,
  loadJSON,
  enrichLearnerResultWithEvidenceRefs,
  evidenceRefsForNote,
  resolveLearnerBackend,
  buildLearnerInvocation,
  buildPrompt,
  boundedCandidatesForPrompt,
  buildLearnerProcessEnv,
  reserveQueueBatch,
  completeQueueBatch,
  failQueueBatch,
  flushCompleted,
  EXIT_TIMEOUT,
};
