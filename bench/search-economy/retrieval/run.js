'use strict';

// Search-economy retrieval bench runner.
//
//   node bench/search-economy/retrieval/run.js
//
// For each corpus query x each IMPLEMENTED arm:
//   - assemble the context bundle (arms.js)
//   - measure tokens (tokens.js, via the arm)
//   - score recall  = |hitSymbols ∩ relevant_symbols| / |relevant_symbols|
//           precision = |hitSymbols ∩ relevant_symbols| / |hitSymbols|   (0 if no symbols)
//           tokens_per_correct_symbol = tokens / |hits|  (Infinity -> null if 0 hits)
// Writes one JSON line per (query, arm) to results.jsonl, then prints a per-arm summary.
//
// Symbol matching is case-INSENSITIVE and whole-token (the arm extracts identifier-like
// tokens; we lowercase both sides and compare as a set), so casing noise doesn't distort recall.

const fs = require('fs');
const path = require('path');

const { assembleContext, implementedArms, listArms, armInfo } = require('./arms');

const HERE = __dirname;
const CORPUS_PATH = path.join(HERE, 'corpus.json');
const RESULTS_PATH = path.join(HERE, 'results.jsonl');

function loadCorpus() {
  const raw = fs.readFileSync(CORPUS_PATH, 'utf8');
  const parsed = JSON.parse(raw);
  if (!parsed || !Array.isArray(parsed.queries)) {
    throw new Error('corpus.json missing queries[]');
  }
  return parsed.queries;
}

function lowerSet(arr) {
  const s = new Set();
  for (const x of arr || []) s.add(String(x).toLowerCase());
  return s;
}

function scoreCase(hitSymbols, relevantSymbols) {
  const hits = lowerSet(hitSymbols);
  const rel = lowerSet(relevantSymbols);
  let correct = 0;
  for (const r of rel) if (hits.has(r)) correct += 1;
  const recall = rel.size ? correct / rel.size : 0;
  const precision = hits.size ? correct / hits.size : 0;
  return { correct, recall, precision, nHits: hits.size, nRelevant: rel.size };
}

function fmt(n, digits = 3) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function pad(s, w) {
  s = String(s);
  return s.length >= w ? s : s + ' '.repeat(w - s.length);
}

async function main() {
  const queries = loadCorpus();
  const arms = implementedArms();
  const deferred = listArms().filter((a) => !arms.includes(a));

  // Fresh results file each run.
  fs.writeFileSync(RESULTS_PATH, '');

  const rows = [];
  const perArm = new Map(); // arm -> accumulator

  for (const arm of arms) perArm.set(arm, { tokens: [], recall: [], precision: [], tpcs: [], n: 0, reachable: 0 });

  for (const q of queries) {
    for (const arm of arms) {
      let assembled;
      try {
        assembled = await assembleContext(q.query, arm, { workspace: process.env.ORCH_SEARCH_WORKSPACE });
      } catch (e) {
        assembled = { bundleText: '', tokens: 0, hitSymbols: [], meta: { error: String(e && e.message || e) } };
      }
      const sc = scoreCase(assembled.hitSymbols, q.relevant_symbols);
      const tokensPerCorrect = sc.correct > 0 ? assembled.tokens / sc.correct : null;

      const row = {
        id: q.id,
        arm,
        query: q.query,
        tokens: assembled.tokens,
        n_hit_symbols: sc.nHits,
        n_relevant: sc.nRelevant,
        correct: sc.correct,
        recall: Number(sc.recall.toFixed(4)),
        precision: Number(sc.precision.toFixed(4)),
        tokens_per_correct_symbol: tokensPerCorrect == null ? null : Number(tokensPerCorrect.toFixed(2)),
        matched_symbols: q.relevant_symbols.filter((s) => lowerSet(assembled.hitSymbols).has(String(s).toLowerCase())),
        meta: assembled.meta || {},
      };
      rows.push(row);
      fs.appendFileSync(RESULTS_PATH, JSON.stringify(row) + '\n');

      const acc = perArm.get(arm);
      acc.tokens.push(assembled.tokens);
      acc.recall.push(sc.recall);
      acc.precision.push(sc.precision);
      if (tokensPerCorrect != null) acc.tpcs.push(tokensPerCorrect);
      acc.n += 1;
      if (assembled.meta && assembled.meta.reachable) acc.reachable += 1;
    }
  }

  const mean = (a) => (a.length ? a.reduce((x, y) => x + y, 0) / a.length : 0);

  // ---- Summary table ----
  console.log('');
  console.log(`Search-economy retrieval bench — ${queries.length} queries x ${arms.length} implemented arm(s)`);
  console.log('');
  const head = `${pad('arm', 14)} ${pad('n', 4)} ${pad('mean_tokens', 12)} ${pad('mean_recall', 12)} ${pad('mean_prec', 10)} ${pad('mean_tok/correct', 16)}`;
  console.log(head);
  console.log('-'.repeat(head.length));
  for (const arm of arms) {
    const acc = perArm.get(arm);
    const tpcsMean = acc.tpcs.length ? mean(acc.tpcs) : null;
    console.log(
      `${pad(arm, 14)} ${pad(acc.n, 4)} ${pad(fmt(mean(acc.tokens), 1), 12)} ${pad(fmt(mean(acc.recall)), 12)} ${pad(fmt(mean(acc.precision)), 10)} ${pad(fmt(tpcsMean, 1), 16)}`
    );
  }
  console.log('');

  // Per-arm notes (reachability for the subconscious arm, deferred arms).
  for (const arm of arms) {
    const acc = perArm.get(arm);
    if (arm === 'subconscious') {
      console.log(`note: subconscious arm reached the daemon on ${acc.reachable}/${acc.n} queries.`);
      if (mean(acc.recall) === 0) {
        console.log('      mean recall 0.000 is EXPECTED until the repo CODE is onboarded into the KB');
        console.log('      (the live KB holds orchestrator self-knowledge notes, not code chunks).');
        console.log('      See README.md "Onboarding caveat". Phase 1 delivers harness correctness, not the win.');
      }
    }
  }
  if (deferred.length) {
    console.log('');
    for (const arm of deferred) {
      const info = armInfo(arm);
      console.log(`deferred: ${pad(arm, 14)} ${info ? info.describe : ''}`);
    }
  }

  console.log('');
  console.log(`Wrote ${rows.length} rows to ${path.relative(process.cwd(), RESULTS_PATH).replace(/\\/g, '/')}`);
}

main().catch((e) => {
  console.error('run.js failed:', e && e.stack || e);
  process.exit(1);
});
