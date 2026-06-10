#!/usr/bin/env node
/**
 * extract-decisions.js — PROPOSE durable-decision note nodes from a conversation turn,
 * behind the same reviewable candidate-bundle / accept-gate as bench/ingest/inject.js.
 *
 * Goal: durable decisions land in the graph WITHOUT an explicit record_decision() call —
 * but never auto-injected. The flow is identical in spirit to ingest-v1:
 *
 *   1. Read a transcript (.jsonl) and isolate SOLO assistant turns (an assistant message
 *      with no tool-result user turn driving it — i.e. the model's own reasoning/conclusion).
 *   2. Heuristically extract decision candidates {title, summary, knowledge[]} from each turn.
 *   3. DEDUP every candidate against the live KB via GET /search (the search_knowledge scorer);
 *      a candidate that already has a strong match in the graph is dropped as a duplicate.
 *   4. Write a reviewable bundle (CANDIDATES.json) and, by DEFAULT, print a dry-run plan and
 *      exit 0 with NO graph mutation.
 *   5. With --confirm, POST each kept candidate to /overlay/note titled '[auto] <title>'
 *      (distinguishable + reversible, exactly like inject.js's '[ingest] ' prefix). Idempotent
 *      via a GET /state title-skip.
 *
 * This is the extractor half of the "cut record_decision friction" task: it stands in for the
 * human/agent who would otherwise have to call record_decision, and routes its proposals through
 * the existing review/accept gate instead of auto-injecting.
 *
 *   node scripts/extract-decisions.js <transcript.jsonl>            # dry run (default, no mutation)
 *   node scripts/extract-decisions.js <transcript.jsonl> --confirm  # inject kept candidates
 *   node scripts/extract-decisions.js <transcript.jsonl> --out bench/extract/CANDIDATES.json
 *   node scripts/extract-decisions.js --turns turns.json            # extract from raw turns (eval)
 *
 * --no-dedup skips the network dedup pass (offline; treats all candidates as novel).
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const DAEMON = process.env.ORCH_DAEMON || 'http://localhost:8787';
const PREFIX = '[auto] ';
const DEDUP_THRESHOLD = Number(process.env.EXTRACT_DEDUP_THRESHOLD || 0.45);

// ---- arg parsing ----------------------------------------------------------
const argv = process.argv.slice(2);
const CONFIRM = argv.includes('--confirm');
const NO_DEDUP = argv.includes('--no-dedup');
const flagVal = (name) => { const i = argv.indexOf(name); return i >= 0 ? argv[i + 1] : null; };
const OUT = flagVal('--out');
const TURNS_FILE = flagVal('--turns');
const POSITIONAL = argv.filter((a, i) => !a.startsWith('--') && argv[i - 1] !== '--out' && argv[i - 1] !== '--turns');
const TRANSCRIPT = POSITIONAL[0] || null;

// ===========================================================================
// 1. TURN EXTRACTION
// ===========================================================================
// A "solo turn" is the assistant's own prose (text blocks) for one assistant message.
// We concatenate the text blocks; thinking blocks are ignored (private, often empty here).
// Returns: [{ text, idx }]
function turnsFromTranscript(file) {
  const lines = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const turns = [];
  for (const line of lines) {
    let ev;
    try { ev = JSON.parse(line); } catch { continue; }
    if (ev.type !== 'assistant') continue;
    const content = ev.message && ev.message.content;
    if (!Array.isArray(content)) continue;
    const text = content
      .filter((b) => b && b.type === 'text' && typeof b.text === 'string')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (text) turns.push({ text, idx: turns.length });
  }
  return turns;
}

// ===========================================================================
// 2. CANDIDATE EXTRACTION (heuristic)
// ===========================================================================
// We look for sentences that signal a DURABLE DECISION / RATIONALE / NON-OBVIOUS FINDING —
// the same bar record_decision documents. The signal is a verb/connective pattern plus a
// reason or constraint, NOT transient status ("running tests", "let me read"). We deliberately
// bias toward PRECISION (drop borderline) per the task's note-node-noise guidance.

// Cue phrases that flag a durable decision / finding / constraint, each with a weight.
// STRONG cues (>=1.5) clear the precision gate on their own — an explicit decision verb, a
// root-cause/finding, or a hard constraint is durable even without a separate because-clause.
// WEAK cues (1.0) need a second signal (another cue or a REASON connective) to qualify.
const DECISION_CUES = [
  { re: /\bchose\b|\bchoosing\b|\bdecided to\b|\bdecision\b|\bwent with\b|\bopted (?:for|to)\b|\bsettled on\b/i, w: 1.5 },
  { re: /\bturns out\b|\bit turns out\b|\bthe (?:root )?cause (?:is|was)\b|\bthe key (?:insight|finding)\b/i, w: 1.5 },
  { re: /\bgotcha\b|\bcaveat\b|\bconstraint\b|\bmust (?:not|never|always)\b|\bcan(?:not|'t) be\b/i, w: 1.5 },
  { re: /\b(?:because|since|so that|in order to|the reason)\b.*\b(?:rather than|instead of|over|vs\.?)\b/i, w: 1.5 },
  { re: /\brather than\b|\binstead of\b|\bover (?:the )?alternative\b/i, w: 1.0 },
  { re: /\bthe trick is\b|\bthe fix is\b|\bthe approach is\b|\bwe (?:should|need to|must)\b/i, w: 1.0 },
];

// Transient / chatter patterns — if a sentence is dominated by these, it's NOT durable.
const TRANSIENT = [
  /\b(?:let me|i'?ll|i will|now i'?ll|next,? i)\b/i,
  /\b(?:running|reading|looking at|checking|opening|let'?s see|first,? )\b/i,
  /\b(?:here'?s|here is) (?:the|a|what)\b/i,
  /\bdone\b\.?$|\ball set\b|\blooks good\b|\bgreat\b[.!]/i,
];

// A reason connective makes a decision durable (decision + WHY).
const REASON = /\b(because|since|so that|in order to|to avoid|to prevent|which means|so it|otherwise)\b/i;

function splitSentences(text) {
  // Keep it simple: split on sentence terminators + newlines, drop list bullets/markup noise.
  return text
    .replace(/```[\s\S]*?```/g, ' ')          // strip fenced code
    .replace(/`[^`]*`/g, ' ')                  // strip inline code
    .split(/(?<=[.!?])\s+|\n+/)
    .map((s) => s.replace(/^[-*\d.)\s]+/, '').trim())
    .filter((s) => s.length >= 25 && s.length <= 400);
}

function scoreSentence(s) {
  let score = 0;
  let cueHits = 0;
  for (const c of DECISION_CUES) if (c.re.test(s)) { score += c.w; cueHits += 1; }
  if (REASON.test(s)) score += 1;
  for (const re of TRANSIENT) if (re.test(s)) score -= 1.5;
  // A bare imperative with no cue and no reason is almost always chatter.
  if (cueHits === 0 && !REASON.test(s)) score -= 2;
  return { score, cueHits };
}

function titleFromSentence(s) {
  // Compact noun-phrase-ish title: trim leading connectives, cap length.
  let t = s
    .replace(/^(so|and|but|because|since|thus|therefore|we|i|the reason is that|note that)\b[,:\s]*/i, '')
    .replace(/\s+/g, ' ')
    .trim();
  t = t.charAt(0).toUpperCase() + t.slice(1);
  if (t.length > 72) t = t.slice(0, 69).replace(/\s+\S*$/, '') + '…';
  return t;
}

// Extract candidates from ONE turn's text. Returns [{title, summary, knowledge[], _score, _turn}].
function candidatesFromText(text, turnIdx) {
  const out = [];
  for (const s of splitSentences(text)) {
    const { score, cueHits } = scoreSentence(s);
    if (score < 1.5) continue;            // precision gate: require a real signal
    out.push({
      title: titleFromSentence(s),
      summary: s,
      knowledge: [
        `origin:auto-extract`,
        `turn:${turnIdx}`,
        `signal:${cueHits ? 'decision-cue' : 'reason'}`,
      ],
      _score: Math.round(score * 100) / 100,
      _turn: turnIdx,
    });
  }
  return out;
}

// Dedup WITHIN this batch (same sentence surfacing twice across turns).
function dedupSelf(cands) {
  const seen = new Set();
  const out = [];
  for (const c of cands.sort((a, b) => b._score - a._score)) {
    const key = c.summary.toLowerCase().replace(/[^a-z0-9 ]/g, '').slice(0, 80);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(c);
  }
  return out;
}

// ===========================================================================
// 3. HTTP (mirrors inject.js)
// ===========================================================================
function request(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, DAEMON);
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = http.request(
      u,
      { method, headers: payload ? { 'content-type': 'application/json', 'content-length': payload.length } : {} },
      (res) => {
        let data = '';
        res.on('data', (c) => (data += c));
        res.on('end', () => {
          let json;
          try { json = data ? JSON.parse(data) : {}; } catch { json = { raw: data }; }
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(json);
          else reject(new Error(`${method} ${urlPath} -> ${res.statusCode}: ${data}`));
        });
      }
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

// Dedup against the live KB via the search_knowledge scorer. A candidate whose top /search
// hit scores >= DEDUP_THRESHOLD is considered already-known and dropped.
async function dedupAgainstKB(cands) {
  if (NO_DEDUP) return cands.map((c) => ({ ...c, _dedup: 'skipped' }));
  const kept = [];
  for (const c of cands) {
    let top = null;
    try {
      const r = await request('GET', `/search?q=${encodeURIComponent(c.title + ' ' + c.summary)}&k=1`);
      top = (r.results && r.results[0]) || null;
    } catch (e) {
      // Daemon down / unreachable: fail open (treat as novel) so the extractor still produces a bundle.
      kept.push({ ...c, _dedup: `error:${e.message.slice(0, 40)}` });
      continue;
    }
    if (top && top.score >= DEDUP_THRESHOLD) {
      c._droppedDup = { key: top.key, title: top.title, score: top.score };
      continue; // duplicate of existing KB — drop
    }
    kept.push({ ...c, _dedup: top ? `novel(top=${top.score})` : 'novel(no-match)' });
  }
  return kept;
}

// ===========================================================================
// 4/5. BUNDLE + DRY-RUN / CONFIRM GATE
// ===========================================================================
function writeBundle(kept, dropped, meta) {
  const outPath = OUT
    ? path.resolve(OUT)
    : path.join(__dirname, '..', 'bench', 'extract', 'CANDIDATES.json');
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  const bundle = {
    generated_at: new Date().toISOString(),
    source: meta.source,
    turns_scanned: meta.turns,
    kept: kept.map(({ title, summary, knowledge, _score, _turn, _dedup }) => ({ title, summary, knowledge, _score, _turn, _dedup })),
    dropped_as_duplicate: dropped.map((c) => ({ title: c.title, _droppedDup: c._droppedDup })),
  };
  fs.writeFileSync(outPath, JSON.stringify(bundle, null, 2));
  return outPath;
}

function printPlan(kept, dropped, bundlePath, meta) {
  console.log('=== extract-decisions.js DRY RUN (no --confirm) ===');
  console.log(`daemon target: ${DAEMON}`);
  console.log(`source:        ${meta.source}`);
  console.log(`turns scanned: ${meta.turns}`);
  console.log(`dedup:         ${NO_DEDUP ? 'OFF (--no-dedup)' : `ON (threshold ${DEDUP_THRESHOLD})`}`);
  console.log('');
  console.log(`PROPOSED ${kept.length} candidate note node(s); dropped ${dropped.length} as KB duplicate(s).`);
  console.log('');
  kept.forEach((c, i) => {
    console.log(`  ${i + 1}. [score ${c._score}] ${PREFIX}${c.title}`);
    console.log(`     ${c.summary}`);
    console.log(`     dedup: ${c._dedup}`);
  });
  if (dropped.length) {
    console.log('');
    console.log('Dropped as duplicate of existing KB:');
    dropped.forEach((c, i) => console.log(`  ${i + 1}. "${c.title}"  ~  ${c._droppedDup.key} (${c._droppedDup.title}) score=${c._droppedDup.score}`));
  }
  console.log('');
  console.log(`Reviewable bundle written: ${bundlePath}`);
  console.log('No graph mutation. Review the bundle, then re-run with --confirm to inject kept candidates.');
}

async function confirmInject(kept) {
  console.log('=== extract-decisions.js CONFIRMED injection ===');
  console.log(`daemon target: ${DAEMON}`);
  // Idempotency: skip any '[auto]' title already present.
  const existing = new Set();
  try {
    const state = await request('GET', '/state');
    for (const t of state.tasks || []) if (typeof t.label === 'string' && t.label.startsWith(PREFIX)) existing.add(t.label);
  } catch (e) {
    console.error(`WARN: could not read /state for idempotency (${e.message}); proceeding without skip-set.`);
  }
  let created = 0, skipped = 0;
  for (const c of kept) {
    const title = PREFIX + c.title;
    if (existing.has(title)) { skipped++; continue; }
    await request('POST', '/overlay/note', {
      title,
      summary: c.summary,
      knowledge: c.knowledge,
      created_by: 'auto-extract',
    });
    existing.add(title);
    created++;
  }
  console.log('');
  console.log('Injection summary:');
  console.log(`  notes created: ${created}`);
  console.log(`  notes skipped: ${skipped}  (already present)`);
  console.log(`Injected nodes are titled with the ${PREFIX.trim()} prefix for easy filtering/removal.`);
}

// ===========================================================================
// MAIN
// ===========================================================================
async function main() {
  let turns, source;
  if (TURNS_FILE) {
    // Eval mode: raw turns [{text}] or ["text", ...]
    const raw = JSON.parse(fs.readFileSync(TURNS_FILE, 'utf8'));
    turns = raw.map((t, i) => ({ text: typeof t === 'string' ? t : t.text, idx: i }));
    source = TURNS_FILE;
  } else if (TRANSCRIPT) {
    turns = turnsFromTranscript(TRANSCRIPT);
    source = TRANSCRIPT;
  } else {
    console.error('usage: node scripts/extract-decisions.js <transcript.jsonl> [--confirm] [--out PATH] [--no-dedup]');
    console.error('   or: node scripts/extract-decisions.js --turns turns.json');
    process.exit(2);
  }

  let cands = [];
  for (const t of turns) cands.push(...candidatesFromText(t.text, t.idx));
  cands = dedupSelf(cands);

  const afterKB = await dedupAgainstKB(cands);
  const kept = afterKB;
  const dropped = cands.filter((c) => c._droppedDup);

  const meta = { source, turns: turns.length };
  const bundlePath = writeBundle(kept, dropped, meta);

  if (!CONFIRM) { printPlan(kept, dropped, bundlePath, meta); process.exit(0); }
  try { await confirmInject(kept); }
  catch (e) { console.error('Injection FAILED:', e.message); process.exit(1); }
}

// Exported for the test harness (no network, pure functions).
module.exports = {
  turnsFromTranscript,
  candidatesFromText,
  splitSentences,
  scoreSentence,
  titleFromSentence,
  dedupSelf,
};

if (require.main === module) main();
