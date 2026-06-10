#!/usr/bin/env node
// Offline regression guard for retrieval quality of search_knowledge (/search). No framework, no
// live daemon (matches test/search-knowledge.test.js style). Run: node test/retrieval-quality.test.js
//
// It reconstructs the SAME KB corpus that bench/ingest/inject.js injects (kept doc-notes + kept
// git-notes + structure nodes, each titled '[ingest] <title>'), scores every query in
// bench/retrieval/eval-set.json with the EXACT scorer behind /search (scoreNodeAgainstTokens +
// suggestToks, imported from daemon.js), and asserts aggregate recall@5 / MRR@5 stay above the
// thresholds that scripts/retrieval-bench.js enforces. This makes the bench reproducible and
// guards against silent retrieval rot in CI, independent of daemon state.
'use strict';

const fs = require('fs');
const path = require('path');
const { scoreNodeAgainstTokens, suggestToks } = require('../daemon');

const ROOT = path.join(__dirname, '..');
const PRIMARY_K = 5;
const THRESH = { recallAtK: 0.85, mrr: 0.80 };

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const loadJSON = (rel) => JSON.parse(fs.readFileSync(path.join(ROOT, rel), 'utf8'));

// ---- rebuild the injected corpus (mirror of bench/ingest/inject.js selection) ----------------
const PREFIX = '[ingest] ';
const GIT_DROP_SOURCES = new Set([
  'f5c4bbadf0e641510b7a79a1670dc630ebb0092e',
  '7f329ec1116c85a958007f0cf599717671a061f3',
  '28164d708a7a6c2157b20744e00fbacd559cd66a',
  'a068e6aff77be7e4afbad557924e9457cfdae2e0',
  '91028c626fd835bb53215ab8f4ee7e727398351d',
  '185d77e26fa622c302f668612e727e2caa91db27',
  'b8a1d6bf494801f2aa49f26a00295e05731cc65a',
]);

const gitNotes = loadJSON('bench/ingest/git-notes.json').filter((n) => !GIT_DROP_SOURCES.has(n.source));
const docNotes = loadJSON('bench/ingest/doc-notes.json');
const structure = loadJSON('bench/ingest/structure.json');

const corpus = [
  ...gitNotes.map((n) => ({ id: `git:${n.source}`, label: PREFIX + n.title, summary: n.summary, kind: 'note' })),
  ...docNotes.map((n) => ({ id: `doc:${n.title}`, label: PREFIX + n.title, summary: n.summary, kind: 'note' })),
  ...structure.nodes.map((n) => ({ id: `struct:${n.id}`, label: PREFIX + n.id, summary: n.role, kind: 'note' })),
];

// ---- the /search code path, reproduced offline -----------------------------------------------
function searchOffline(query, k) {
  const qt = suggestToks(query);
  return corpus
    .map((node) => ({ title: node.label, score: scoreNodeAgainstTokens(node, qt).score }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k);
}

// ---- scoring metrics (mirror scripts/retrieval-bench.js) --------------------------------------
const stripPrefix = (t) => String(t || '').replace(/^\[ingest\]\s*/i, '').trim().toLowerCase();
function scoreCase(resultTitles, relevantTitles, k) {
  const top = resultTitles.slice(0, k).map(stripPrefix);
  const rel = new Set(relevantTitles.map(stripPrefix));
  const hits = top.filter((t) => rel.has(t)).length;
  const recall = relevantTitles.length ? hits / relevantTitles.length : 0;
  let rr = 0;
  for (let i = 0; i < top.length; i++) { if (rel.has(top[i])) { rr = 1 / (i + 1); break; } }
  return { recall, mrr: rr };
}
const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);

// ---- run the eval set ------------------------------------------------------------------------
const evalSet = loadJSON('bench/retrieval/eval-set.json');
const cases = evalSet.cases;

ok('eval set is non-empty', cases.length > 0);

// every relevant title in the eval set actually exists in the corpus (catches typos/drift)
{
  const corpusTitles = new Set(corpus.map((n) => stripPrefix(n.label)));
  const missing = [];
  for (const c of cases) for (const t of c.relevant_titles) if (!corpusTitles.has(stripPrefix(t))) missing.push(t);
  ok('all relevant titles exist in corpus' + (missing.length ? ` (missing: ${missing.join(' | ')})` : ''), missing.length === 0);
}

const recalls = [], mrrs = [];
let zeroRecall = [];
for (const c of cases) {
  const results = searchOffline(c.query, PRIMARY_K).map((r) => r.title);
  const s = scoreCase(results, c.relevant_titles, PRIMARY_K);
  recalls.push(s.recall);
  mrrs.push(s.mrr);
  if (s.recall === 0) zeroRecall.push(c.query);
}

const aggRecall = mean(recalls);
const aggMrr = mean(mrrs);
console.log(`\naggregate @${PRIMARY_K}: recall=${aggRecall.toFixed(4)} MRR=${aggMrr.toFixed(4)}  (queries=${cases.length})`);
if (zeroRecall.length) console.log(`zero-recall queries: ${zeroRecall.map((q) => `"${q.slice(0, 50)}"`).join(', ')}`);

ok(`recall@${PRIMARY_K} (${aggRecall.toFixed(3)}) >= ${THRESH.recallAtK}`, aggRecall >= THRESH.recallAtK);
ok(`MRR@${PRIMARY_K} (${aggMrr.toFixed(3)}) >= ${THRESH.mrr}`, aggMrr >= THRESH.mrr);

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
