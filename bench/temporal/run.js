#!/usr/bin/env node
// Temporal / state-change retrieval benchmark runner.
//
// A fact CHANGES over time (deploy target: fly.io -> render -> railway), recorded as superseding note
// nodes that preserve history. Each query asks for either the CURRENT fact or the fact CURRENT at a
// past instant (as-of). We run the SAME retrieval the daemon's /search endpoint uses — the shared
// token scorer (scoreNodeAgainstTokens) plus the as-of temporal filter (noteCurrentAsOf) — entirely
// in-process (no daemon, no LLM), so the result is deterministic and CI-friendly.
//
// Scoring: recall@k and MRR, the standard retrieval-quality metrics, so this stays compatible with the
// recall@k/MRR scorer being built in parallel. Output (stdout JSON, also written to report.json):
//   { metric:"retrieval", recall_at_k, mrr, k, n, per_query:[ {id, as_of, relevant, retrieved, hit, rank, rr} ] }
// Run:  node bench/temporal/run.js [--k N]   Exits non-zero if recall@k < 1 (every query must hit).
'use strict';
const fs = require('fs');
const path = require('path');
const ov = require('../../lib/overlay');
const { scoreNodeAgainstTokens, suggestToks, noteCurrentAsOf } = require('../../daemon');

const DATA = JSON.parse(fs.readFileSync(path.join(__dirname, 'dataset.json'), 'utf8'));
const Karg = (() => { const i = process.argv.indexOf('--k'); return i >= 0 ? parseInt(process.argv[i + 1], 10) : null; })();

// --- build the temporal KB in an overlay, then index notes by label so the dataset can reference
//     them by human-readable title (ids are random). ---
const overlay = ov.EMPTY();
const idByLabel = {};
for (const n of DATA.notes) idByLabel[n.label] = ov.addNoteNode(overlay, { title: n.label, summary: n.summary, valid_from: n.valid_from });
for (const [oldL, newL] of DATA.supersede) ov.supersedeNote(overlay, idByLabel[oldL], idByLabel[newL]);

// --- materialize graph nodes exactly as buildGraph emits them (label/summary/kind + temporal fields). ---
const nodes = Object.values(overlay.note_nodes).map((n) => ({
  id: 'note:' + n.id, label: n.title, summary: n.summary, kind: 'note',
  validFrom: n.validFrom || null, validTo: n.validTo || null,
}));

// --- the /search retrieval, replicated: temporal filter (default = current-only; as_of = point-in-
//     time) then token-score, sort desc, take top-k. ---
function search(query, asOf, k) {
  const qt = suggestToks(query);
  const temporalOk = (node) => {
    if (asOf) return noteCurrentAsOf(node, asOf);
    if ((node.kind || 'task') !== 'note') return true;
    return !node.validTo;                 // default: only still-current notes
  };
  return nodes
    .filter(temporalOk)
    .map((node) => ({ key: node.id, title: node.label, ...scoreNodeAgainstTokens(node, qt) }))
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((r) => r.title);
}

// --- score: recall@k (a query "hits" if any gold title is in top-k) + MRR (1/rank of first gold). ---
const perQuery = DATA.queries.map((qd) => {
  const k = Karg || qd.k || 5;
  const retrieved = search(qd.query, qd.as_of, k);
  const gold = new Set(qd.relevant);
  let rank = 0;
  for (let i = 0; i < retrieved.length; i++) if (gold.has(retrieved[i])) { rank = i + 1; break; }
  const hit = rank > 0;
  return { id: qd.id, as_of: qd.as_of, relevant: qd.relevant, retrieved, hit, rank, rr: hit ? 1 / rank : 0 };
});

// --- BASELINE control: a non-temporal KB ignores as_of and always returns the LATEST fact (validTo
//     null only). This is exactly the Zep-gap a flat KB has — it can't answer "what was true then?".
//     Scoring it on the same dataset quantifies the temporal win (as-of queries miss). ---
function searchLatestOnly(query, k) { return search(query, null, k); }  // null asOf = current-only
const baseline = DATA.queries.map((qd) => {
  const k = Karg || qd.k || 5;
  const retrieved = searchLatestOnly(qd.query, k);
  const gold = new Set(qd.relevant);
  let rank = 0;
  for (let i = 0; i < retrieved.length; i++) if (gold.has(retrieved[i])) { rank = i + 1; break; }
  return { id: qd.id, hit: rank > 0, rr: rank > 0 ? 1 / rank : 0 };
});

const n = perQuery.length;
const recall_at_k = perQuery.filter((q) => q.hit).length / n;
const mrr = perQuery.reduce((s, q) => s + q.rr, 0) / n;
const baseline_recall = round(baseline.filter((q) => q.hit).length / n);
const baseline_mrr = round(baseline.reduce((s, q) => s + q.rr, 0) / n);
const report = { metric: 'retrieval', recall_at_k: round(recall_at_k), mrr: round(mrr), baseline_recall_at_k: baseline_recall, baseline_mrr, k: Karg || 5, n, per_query: perQuery };

fs.writeFileSync(path.join(__dirname, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
console.log(`\ntemporal  recall@${report.k}=${report.recall_at_k}  MRR=${report.mrr}`);
console.log(`baseline  recall@${report.k}=${report.baseline_recall_at_k}  MRR=${report.baseline_mrr}  (latest-only, no as-of)  (n=${n})`);
// Guard: prove the temporal win — every query (incl. the as-of ones a non-temporal KB would MISS by
// returning only the latest) must retrieve its gold fact.
process.exit(recall_at_k >= 1 ? 0 : 1);

function round(x) { return Math.round(x * 1000) / 1000; }
