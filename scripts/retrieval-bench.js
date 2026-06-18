#!/usr/bin/env node
/**
 * retrieval-bench.js — retrieval-quality benchmark for search_knowledge (/search).
 *
 * Runs every query in bench/retrieval/eval-set.json through the daemon's current /search endpoint
 * (the route used by the search_knowledge MCP tool) and computes, per query
 * and aggregated:
 *   - recall@k      = |relevant retrieved in top-k| / |relevant|
 *   - precision@k   = |relevant retrieved in top-k| / k
 *   - MRR           = 1 / rank-of-first-relevant   (0 if none retrieved)
 *
 * Relevance is keyed on the note TITLE in the eval set (see eval-set.json "match":"title");
 * results from /search are matched by stripping the '[ingest] ' prefix and comparing
 * case-insensitively, so the set is stable across re-ingestion / changing note IDs.
 *
 * Held-out mode (--heldout / --eval=heldout) aggregates recall@k per candidate across agent-style
 * query distributions; interval-merge is a negative control (no scar note).
 *
 * Emits bench/retrieval/scorecard.json + scorecard.md, or heldout-scorecard.json + .md.
 *
 *   node scripts/retrieval-bench.js                 # k=5 (default), against $ORCH_DAEMON
 *   node scripts/retrieval-bench.js --heldout       # held-out eval set
 *   node scripts/retrieval-bench.js --heldout --isolated  # frozen snapshot daemon
 *   node scripts/retrieval-bench.js --k=3,5,10      # multiple cutoffs
 *   node scripts/retrieval-bench.js --no-write      # print only, do not write scorecard files
 *   node scripts/retrieval-bench.js --check         # exit non-zero if below thresholds (see THRESHOLDS)
 *
 * Exit code: 0 normally; with --check, non-zero if any threshold is violated (regression guard
 * for CI / smoke). The same scoring logic is unit-tested offline in test/retrieval-quality.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const HERE = __dirname;
const ROOT = path.join(HERE, '..');
const EVAL_DEFAULT = path.join(ROOT, 'bench', 'retrieval', 'eval-set.json');
const HELDOUT_EVAL = path.join(ROOT, 'bench', 'retrieval', 'heldout-eval-set.json');
const OUT_JSON_DEFAULT = path.join(ROOT, 'bench', 'retrieval', 'scorecard.json');
const OUT_MD_DEFAULT = path.join(ROOT, 'bench', 'retrieval', 'scorecard.md');
const OUT_JSON_HELDOUT = path.join(ROOT, 'bench', 'retrieval', 'heldout-scorecard.json');
const OUT_MD_HELDOUT = path.join(ROOT, 'bench', 'retrieval', 'heldout-scorecard.md');

// Regression thresholds on the PRIMARY cutoff (k=5). Tuned to current measured quality with
// headroom; --check fails below these so retrieval can't silently rot. Bump only with a measured
// improvement.
const PRIMARY_K = 5;
const THRESHOLDS = {
  recallAtK: 0.85,   // most queries must surface their relevant note in top-5
  mrr: 0.80,         // and usually at or near rank 1
};

const HELDOUT_THRESHOLDS = {
  perCandidateRecall: {
    'task-transcript': 0.75,
    'locale-sum': 0.60,
    'bench-metric': 0.35,
  },
  negativeMaxContamination: 0,
};

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getOpt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const evalMode = (() => {
  if (hasFlag('--heldout')) return 'heldout';
  return getOpt('eval', 'default') === 'heldout' ? 'heldout' : 'default';
})();
const IS_HELDOUT = evalMode === 'heldout';
const ISOLATED = hasFlag('--isolated');
const KS = String(getOpt('k', String(PRIMARY_K)))
  .split(',')
  .map((s) => parseInt(s, 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const WRITE = !hasFlag('--no-write');
const CHECK = hasFlag('--check');

let DAEMON = process.env.ORCH_DAEMON || 'http://localhost:8787';
let WORKSPACE = process.env.ZONOID_WORKSPACE || process.env.ORCH_WORKSPACE || ROOT;
let EVAL_PATH = IS_HELDOUT ? HELDOUT_EVAL : EVAL_DEFAULT;
let OUT_JSON = IS_HELDOUT ? OUT_JSON_HELDOUT : OUT_JSON_DEFAULT;
let OUT_MD = IS_HELDOUT ? OUT_MD_HELDOUT : OUT_MD_DEFAULT;

// ---- helpers --------------------------------------------------------------
const stripPrefix = (t) => String(t || '').replace(/^\[ingest\]\s*/i, '').trim().toLowerCase();
const titleKey = (t) => stripPrefix(t);

function httpGetJSON(urlPath, daemon = DAEMON) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, daemon);
    const req = http.get(u, (res) => {
      let data = '';
      res.on('data', (c) => (data += c));
      res.on('end', () => {
        try {
          if (res.statusCode >= 200 && res.statusCode < 300) resolve(JSON.parse(data || '{}'));
          else reject(new Error(`${urlPath} -> ${res.statusCode}: ${data.slice(0, 200)}`));
        } catch (e) { reject(new Error(`${urlPath} bad JSON: ${e.message}`)); }
      });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => req.destroy(new Error(`${urlPath} timed out`)));
  });
}

function buildSearchPath(q, k, workspace = WORKSPACE) {
  const params = new URLSearchParams();
  params.set('workspace', workspace);
  params.set('q', q);
  params.set('k', String(k));
  return `/search?${params.toString()}`;
}

const search = (q, k, options = {}) => httpGetJSON(
  buildSearchPath(q, k, options.workspace || WORKSPACE),
  options.daemon || DAEMON
);

// EMBED-WARMUP GATE — blocks until the daemon's /search path is serving SEMANTIC results
// (MiniLM sidecar lazy-loaded AND the daemon process's embed() connection is live), then proves
// it. The held-out bench previously fired its first queries before warmup, so /search silently
// fell back to LEXICAL-only ranking (qvec===null in the compiler-backed memory search) and the whole ladder was
// measured against an under-scored cold baseline. We detect warmth from the per-result `via`
// field (`semantic` vs `lexical`): a probe whose top hits all come back `via:'semantic'` proves
// the embedder is warm end-to-end through this daemon. HARD-FAIL on timeout — never silently
// score on a cold/lexical embedder again.
const WARMUP_PROBE = 'how do I capture the full task transcript for a held-out grading run';
const WARMUP_TIMEOUT_MS = 90_000;   // first cold sidecar load can take 10–90s
const WARMUP_POLL_MS = 300;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function warmupGate({ probe = WARMUP_PROBE, timeoutMs = WARMUP_TIMEOUT_MS, pollMs = WARMUP_POLL_MS, searchFn = search } = {}) {
  const deadline = Date.now() + timeoutMs;
  let lastVias = null;
  let attempts = 0;
  while (Date.now() < deadline) {
    attempts++;
    let results = [];
    try {
      const r = await searchFn(probe, PRIMARY_K);
      results = r.results || [];
    } catch (e) {
      // daemon transiently unready — keep polling until the timeout
      await sleep(pollMs);
      continue;
    }
    const vias = results.map((x) => x.via).filter(Boolean);
    lastVias = vias;
    // Warm iff the probe surfaced results AND every scored hit went through the semantic path.
    // A single `lexical` via means qvec was null ⇒ cold fallback ⇒ keep waiting.
    if (vias.length > 0 && vias.every((v) => v === 'semantic')) {
      console.log(`embed warmup: SEMANTIC after ${attempts} probe(s) (${vias.length} hits via semantic)`);
      return { warm: true, attempts, vias };
    }
    await sleep(pollMs);
  }
  // Never warmed within the budget — HARD FAIL. A cold/lexical baseline is worse than no baseline.
  console.error(
    `FATAL: embed warmup gate timed out after ${timeoutMs}ms — /search still serving via=[${(lastVias || []).join(',') || 'none'}]. ` +
    `Refusing to score on a cold/lexical embedder (would silently under-measure recall). ` +
    `Check the MiniLM sidecar (lib/embed-server.js) and the daemon's embed() connection.`
  );
  process.exit(3);
}

// recall/precision/mrr for one query at one cutoff k, given the ordered result titles and the
// set of relevant title-keys.
function scoreCase(resultTitleKeys, relevantKeys, k) {
  const topK = resultTitleKeys.slice(0, k);
  const relSet = new Set(relevantKeys);
  const hit = topK.filter((t) => relSet.has(t));
  const recall = relevantKeys.length ? hit.length / relevantKeys.length : 0;
  const precision = k ? hit.length / k : 0;
  // MRR over the FULL returned list (rank of first relevant), capped at k for fairness with the
  // cutoff: we evaluate the same top-k window the user would actually see.
  let rr = 0;
  for (let i = 0; i < topK.length; i++) {
    if (relSet.has(topK[i])) { rr = 1 / (i + 1); break; }
  }
  return { recall, precision, mrr: rr, hits: hit.length, relevant: relevantKeys.length };
}

function scoreNegativeCase(resultTitleKeys, forbiddenKeys, k) {
  const topK = resultTitleKeys.slice(0, k);
  const forbidden = new Set(forbiddenKeys);
  const contaminated = topK.some((t) => forbidden.has(t));
  return { recall: contaminated ? 0 : 1, precision: contaminated ? 0 : 1, mrr: contaminated ? 0 : 1, hits: contaminated ? 1 : 0, relevant: 0, contaminated };
}

function collectPositiveTitles(candidates) {
  const titles = [];
  for (const c of candidates) {
    if (c.negative) continue;
    for (const t of c.relevant_titles || []) titles.push(titleKey(t));
  }
  return titles;
}

function aggregateCandidateRecall(queryRows, k) {
  const recalls = queryRows.map((r) => (r.k[k] || {}).recall).filter((x) => typeof x === 'number');
  const mrrs = queryRows.map((r) => (r.k[k] || {}).mrr).filter((x) => typeof x === 'number');
  return { recall: mean(recalls), mrr: mean(mrrs), num_queries: queryRows.length };
}

function checkHeldoutThresholds(scorecard, k = PRIMARY_K) {
  const violations = [];
  for (const cand of scorecard.candidates || []) {
    const agg = cand.aggregate[k];
    if (!agg) { violations.push(`${cand.id}: missing aggregate @${k}`); continue; }
    if (cand.negative) {
      const contaminated = (cand.queries || []).filter((q) => q.contaminated).length;
      if (contaminated > HELDOUT_THRESHOLDS.negativeMaxContamination) {
        violations.push(`${cand.id}: contamination ${contaminated} queries`);
      }
    } else {
      const floor = HELDOUT_THRESHOLDS.perCandidateRecall[cand.id];
      if (floor != null && agg.recall < floor) violations.push(`${cand.id}: recall@${k} ${round(agg.recall)} < ${floor}`);
    }
  }
  return violations;
}

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x, n = 4) => Math.round(x * 10 ** n) / 10 ** n;

async function runDefaultEval() {
  const evalSet = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
  const cases = evalSet.cases || [];
  if (!cases.length) { console.error('eval-set has no cases'); process.exit(1); }

  // Ping so a down daemon fails loud rather than as silent zero-recall.
  try { await httpGetJSON('/ping'); }
  catch (e) { console.error(`Daemon not reachable at ${DAEMON}: ${e.message}`); process.exit(2); }

  // Block until the embedder is warm — /ping only proves the daemon is up, not that MiniLM is
  // loaded and the embed() connection is live. Without this the first queries score lexical-only.
  await warmupGate();

  const perK = {};
  for (const k of KS) perK[k] = { recall: [], precision: [], mrr: [] };
  const detail = [];
  const fetchK = Math.max(...KS);

  for (const c of cases) {
    const relevantKeys = (c.relevant_titles || []).map(titleKey);
    let resultTitleKeys = [];
    try {
      const r = await search(c.query, fetchK);
      resultTitleKeys = (r.results || []).map((x) => titleKey(x.title));
    } catch (e) {
      console.error(`  WARN query failed (${c.query.slice(0, 40)}...): ${e.message}`);
    }
    const row = { query: c.query, relevant: c.relevant_titles, k: {} };
    for (const k of KS) {
      const s = scoreCase(resultTitleKeys, relevantKeys, k);
      perK[k].recall.push(s.recall);
      perK[k].precision.push(s.precision);
      perK[k].mrr.push(s.mrr);
      row.k[k] = { recall: round(s.recall), precision: round(s.precision), mrr: round(s.mrr), hits: s.hits, of: s.relevant };
    }
    row.top = resultTitleKeys.slice(0, fetchK);
    detail.push(row);
  }

  const aggregate = {};
  for (const k of KS) {
    aggregate[k] = {
      recall: round(mean(perK[k].recall)),
      precision: round(mean(perK[k].precision)),
      mrr: round(mean(perK[k].mrr)),
    };
  }

  const scorecard = {
    generated_at: new Date().toISOString(),
    daemon: DAEMON,
    workspace: WORKSPACE,
    eval_set: path.relative(ROOT, EVAL_PATH),
    eval_set_version: evalSet.version || null,
    num_queries: cases.length,
    ks: KS,
    primary_k: PRIMARY_K,
    thresholds: THRESHOLDS,
    aggregate,
    detail,
  };

  // ---- thresholds (regression guard) --------------------------------------
  const prim = aggregate[PRIMARY_K];
  let violations = [];
  if (prim) {
    if (prim.recall < THRESHOLDS.recallAtK) violations.push(`recall@${PRIMARY_K} ${prim.recall} < ${THRESHOLDS.recallAtK}`);
    if (prim.mrr < THRESHOLDS.mrr) violations.push(`MRR@${PRIMARY_K} ${prim.mrr} < ${THRESHOLDS.mrr}`);
  } else {
    violations.push(`primary cutoff k=${PRIMARY_K} not in --k set ${KS.join(',')}`);
  }
  scorecard.passed = violations.length === 0;
  scorecard.violations = violations;
  return scorecard;
}

async function runHeldoutEval() {
  const evalSet = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
  const candidates = evalSet.candidates || [];
  if (!candidates.length) { console.error('heldout-eval-set has no candidates'); process.exit(1); }

  try { await httpGetJSON('/ping'); }
  catch (e) { console.error(`Daemon not reachable at ${DAEMON}: ${e.message}`); process.exit(2); }

  // Block until the embedder is warm (see warmupGate). The held-out ladder is measured against
  // these numbers — a cold/lexical baseline silently under-scores recall, so HARD-FAIL if cold.
  await warmupGate();

  const forbiddenTitles = collectPositiveTitles(candidates);
  const fetchK = Math.max(...KS);
  const candidateRows = [];

  for (const cand of candidates) {
    const relevantKeys = (cand.relevant_titles || []).map(titleKey);
    const queryRows = [];
    for (const query of cand.queries || []) {
      let resultTitleKeys = [];
      try {
        const r = await search(query, fetchK);
        resultTitleKeys = (r.results || []).map((x) => titleKey(x.title));
      } catch (e) {
        console.error(`  WARN ${cand.id} query failed (${query.slice(0, 40)}...): ${e.message}`);
      }
      const row = { query, relevant: cand.relevant_titles, k: {} };
      for (const k of KS) {
        const s = cand.negative
          ? scoreNegativeCase(resultTitleKeys, forbiddenTitles, k)
          : scoreCase(resultTitleKeys, relevantKeys, k);
        row.k[k] = { recall: round(s.recall), precision: round(s.precision), mrr: round(s.mrr), hits: s.hits, of: s.relevant };
        if (cand.negative) row.contaminated = !!s.contaminated;
      }
      row.top = resultTitleKeys.slice(0, fetchK);
      queryRows.push(row);
    }
    const aggregate = {};
    for (const k of KS) {
      const agg = aggregateCandidateRecall(queryRows, k);
      aggregate[k] = { recall: round(agg.recall), mrr: round(agg.mrr), num_queries: agg.num_queries };
    }
    candidateRows.push({ id: cand.id, negative: !!cand.negative, relevant_titles: cand.relevant_titles, aggregate, queries: queryRows });
  }

  const scorecard = {
    generated_at: new Date().toISOString(),
    daemon: DAEMON,
    workspace: WORKSPACE,
    mode: 'heldout',
    isolated: ISOLATED,
    eval_set: path.relative(ROOT, EVAL_PATH),
    eval_set_version: evalSet.version || null,
    num_candidates: candidates.length,
    num_queries: candidates.reduce((n, c) => n + (c.queries || []).length, 0),
    ks: KS,
    primary_k: PRIMARY_K,
    thresholds: HELDOUT_THRESHOLDS,
    forbidden_titles: forbiddenTitles,
    candidates: candidateRows,
  };
  const violations = checkHeldoutThresholds(scorecard, PRIMARY_K);
  scorecard.passed = violations.length === 0;
  scorecard.violations = violations;
  return scorecard;
}

async function main() {
  let snap = null;
  if (ISOLATED) {
    snap = require('./bench-snapshot-daemon');
    const port = await snap.ensureRunning({ refreshSnapshot: false });
    DAEMON = `http://127.0.0.1:${port}`;
    WORKSPACE = snap.SNAPSHOT_WS;
    console.log(`isolated snapshot daemon on ${DAEMON} (workspace ${WORKSPACE})`);
  }

  try {
    const scorecard = IS_HELDOUT ? await runHeldoutEval() : await runDefaultEval();

    if (WRITE) {
      fs.writeFileSync(OUT_JSON, JSON.stringify(scorecard, null, 2) + '\n');
      fs.writeFileSync(OUT_MD, IS_HELDOUT ? renderHeldoutMd(scorecard) : renderMd(scorecard));
      console.log(`wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}`);
    }
    console.log(IS_HELDOUT ? renderHeldoutSummary(scorecard) : renderSummary(scorecard));

    if (CHECK && scorecard.violations.length) {
      console.error(`\nFAIL (--check): ${scorecard.violations.join('; ')}`);
      process.exit(1);
    }
  } finally {
    if (snap) snap.teardown();
  }
}

function renderSummary(sc) {
  const lines = [`retrieval scorecard — ${sc.num_queries} queries, daemon ${sc.daemon}`];
  for (const k of sc.ks) {
    const a = sc.aggregate[k];
    lines.push(`  @${k}: recall=${a.recall}  precision=${a.precision}  MRR=${a.mrr}`);
  }
  lines.push(`  primary k=${sc.primary_k} thresholds recall>=${sc.thresholds.recallAtK} MRR>=${sc.thresholds.mrr}: ${sc.passed ? 'PASS' : 'FAIL — ' + sc.violations.join('; ')}`);
  return lines.join('\n');
}

function renderHeldoutSummary(sc) {
  const lines = [`held-out retrieval scorecard — ${sc.num_candidates} candidates, ${sc.num_queries} queries, daemon ${sc.daemon}`];
  for (const cand of sc.candidates) {
    const a = cand.aggregate[sc.primary_k] || {};
    lines.push(`  ${cand.id}${cand.negative ? ' (negative)' : ''}: recall@${sc.primary_k}=${a.recall} MRR=${a.mrr} (${a.num_queries} queries)`);
  }
  lines.push(`  status: ${sc.passed ? 'PASS' : 'FAIL — ' + sc.violations.join('; ')}`);
  return lines.join('\n');
}

function renderMd(sc) {
  const L = [];
  L.push(`# Retrieval-quality scorecard — search_knowledge`);
  L.push('');
  L.push(`Generated: ${sc.generated_at}  `);
  L.push(`Daemon: \`${sc.daemon}\`  `);
  L.push(`Workspace: \`${sc.workspace}\`  `);
  L.push(`Eval set: \`${sc.eval_set}\` (v${sc.eval_set_version}, ${sc.num_queries} queries)  `);
  L.push(`Status: **${sc.passed ? 'PASS' : 'FAIL'}**${sc.passed ? '' : ' — ' + sc.violations.join('; ')}`);
  L.push('');
  L.push('## Aggregate (mean over queries)');
  L.push('');
  L.push('| k | recall@k | precision@k | MRR@k |');
  L.push('|---|----------|-------------|-------|');
  for (const k of sc.ks) {
    const a = sc.aggregate[k];
    L.push(`| ${k} | ${a.recall} | ${a.precision} | ${a.mrr} |`);
  }
  L.push('');
  L.push(`Primary cutoff **k=${sc.primary_k}**; regression thresholds: recall@${sc.primary_k} ≥ ${sc.thresholds.recallAtK}, MRR@${sc.primary_k} ≥ ${sc.thresholds.mrr}.`);
  L.push('');
  L.push('## Per-query (at primary k)');
  L.push('');
  L.push(`| query | relevant | recall | MRR | first hit rank |`);
  L.push('|-------|----------|--------|-----|----------------|');
  for (const d of sc.detail) {
    const m = d.k[sc.primary_k] || {};
    const relTitles = (d.relevant || []).map((t) => stripPrefix(t));
    const rank = (() => {
      const relSet = new Set(relTitles);
      const i = d.top.findIndex((t) => relSet.has(t));
      return i < 0 ? '—' : i + 1;
    })();
    L.push(`| ${d.query.replace(/\|/g, '\\|')} | ${(d.relevant || []).length} | ${m.recall} | ${m.mrr} | ${rank} |`);
  }
  L.push('');
  return L.join('\n') + '\n';
}

function renderHeldoutMd(sc) {
  const L = [];
  L.push('# Held-out retrieval scorecard — search_knowledge');
  L.push('');
  L.push(`Generated: ${sc.generated_at}  `);
  L.push(`Daemon: \`${sc.daemon}\`${sc.isolated ? ' (isolated snapshot)' : ''}  `);
  L.push(`Workspace: \`${sc.workspace}\`  `);
  L.push(`Eval set: \`${sc.eval_set}\` (v${sc.eval_set_version})  `);
  L.push(`Status: **${sc.passed ? 'PASS' : 'FAIL'}**${sc.passed ? '' : ' — ' + sc.violations.join('; ')}`);
  L.push('');
  L.push(`## Per-candidate aggregate (k=${sc.primary_k})`);
  L.push('');
  L.push('| candidate | negative | recall@k | MRR@k | queries |');
  L.push('|-----------|----------|----------|-------|---------|');
  for (const cand of sc.candidates) {
    const a = cand.aggregate[sc.primary_k] || {};
    L.push(`| ${cand.id} | ${cand.negative ? 'yes' : 'no'} | ${a.recall} | ${a.mrr} | ${a.num_queries} |`);
  }
  L.push('');
  for (const cand of sc.candidates) {
    L.push(`### ${cand.id}${cand.negative ? ' (negative control)' : ''}`);
    L.push('');
    L.push('| query | recall | MRR | contaminated |');
    L.push('|-------|--------|-----|--------------|');
    for (const q of cand.queries) {
      const m = q.k[sc.primary_k] || {};
      L.push(`| ${q.query.replace(/\|/g, '\\|')} | ${m.recall} | ${m.mrr} | ${q.contaminated ? 'yes' : '—'} |`);
    }
    L.push('');
  }
  return L.join('\n') + '\n';
}

if (require.main === module) {
  main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
}

module.exports = {
  stripPrefix,
  titleKey,
  scoreCase,
  scoreNegativeCase,
  buildSearchPath,
  search,
  warmupGate,
  WARMUP_PROBE,
  aggregateCandidateRecall,
  checkHeldoutThresholds,
  collectPositiveTitles,
  mean,
  round,
  PRIMARY_K,
  THRESHOLDS,
  HELDOUT_THRESHOLDS,
};
