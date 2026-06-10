#!/usr/bin/env node
/**
 * retrieval-bench.js — retrieval-quality benchmark for search_knowledge (/search).
 *
 * Runs every query in bench/retrieval/eval-set.json through the daemon's /search endpoint
 * (the IDENTICAL scorer that backs the search_knowledge MCP tool) and computes, per query
 * and aggregated:
 *   - recall@k      = |relevant retrieved in top-k| / |relevant|
 *   - precision@k   = |relevant retrieved in top-k| / k
 *   - MRR           = 1 / rank-of-first-relevant   (0 if none retrieved)
 *
 * Relevance is keyed on the note TITLE in the eval set (see eval-set.json "match":"title");
 * results from /search are matched by stripping the '[ingest] ' prefix and comparing
 * case-insensitively, so the set is stable across re-ingestion / changing note IDs.
 *
 * Emits a reproducible scorecard: bench/retrieval/scorecard.json + scorecard.md.
 *
 *   node scripts/retrieval-bench.js                 # k=5 (default), against $ORCH_DAEMON
 *   node scripts/retrieval-bench.js --k=3,5,10      # multiple cutoffs
 *   node scripts/retrieval-bench.js --no-write      # print only, do not write scorecard files
 *   node scripts/retrieval-bench.js --check         # exit non-zero if below thresholds (see THRESHOLDS)
 *
 * Exit code: 0 normally; with --check, non-zero if any threshold is violated (regression guard
 * for CI / smoke). The same threshold logic is unit-tested offline in test/retrieval-quality.test.js.
 */
'use strict';

const fs = require('fs');
const path = require('path');
const http = require('http');

const DAEMON = process.env.ORCH_DAEMON || 'http://localhost:8787';
const HERE = __dirname;
const ROOT = path.join(HERE, '..');
const EVAL_PATH = path.join(ROOT, 'bench', 'retrieval', 'eval-set.json');
const OUT_JSON = path.join(ROOT, 'bench', 'retrieval', 'scorecard.json');
const OUT_MD = path.join(ROOT, 'bench', 'retrieval', 'scorecard.md');

// Regression thresholds on the PRIMARY cutoff (k=5). Tuned to current measured quality with
// headroom; --check fails below these so retrieval can't silently rot. Bump only with a measured
// improvement.
const PRIMARY_K = 5;
const THRESHOLDS = {
  recallAtK: 0.85,   // most queries must surface their relevant note in top-5
  mrr: 0.80,         // and usually at or near rank 1
};

// ---- args -----------------------------------------------------------------
const args = process.argv.slice(2);
const hasFlag = (f) => args.includes(f);
const getOpt = (name, def) => {
  const a = args.find((x) => x.startsWith(`--${name}=`));
  return a ? a.slice(name.length + 3) : def;
};
const KS = String(getOpt('k', String(PRIMARY_K)))
  .split(',')
  .map((s) => parseInt(s, 10))
  .filter((n) => Number.isFinite(n) && n > 0);
const WRITE = !hasFlag('--no-write');
const CHECK = hasFlag('--check');

// ---- helpers --------------------------------------------------------------
const stripPrefix = (t) => String(t || '').replace(/^\[ingest\]\s*/i, '').trim().toLowerCase();
const titleKey = (t) => stripPrefix(t);

function httpGetJSON(urlPath) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlPath, DAEMON);
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

const search = (q, k) => httpGetJSON(`/search?q=${encodeURIComponent(q)}&k=${k}`);

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

const mean = (xs) => (xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0);
const round = (x, n = 4) => Math.round(x * 10 ** n) / 10 ** n;

// ---- run ------------------------------------------------------------------
async function main() {
  const evalSet = JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8'));
  const cases = evalSet.cases || [];
  if (!cases.length) { console.error('eval-set has no cases'); process.exit(1); }

  // Ping so a down daemon fails loud rather than as silent zero-recall.
  try { await httpGetJSON('/ping'); }
  catch (e) { console.error(`Daemon not reachable at ${DAEMON}: ${e.message}`); process.exit(2); }

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

  // ---- emit ---------------------------------------------------------------
  if (WRITE) {
    fs.writeFileSync(OUT_JSON, JSON.stringify(scorecard, null, 2) + '\n');
    fs.writeFileSync(OUT_MD, renderMd(scorecard));
    console.log(`wrote ${path.relative(ROOT, OUT_JSON)} and ${path.relative(ROOT, OUT_MD)}`);
  }
  console.log(renderSummary(scorecard));

  if (CHECK && violations.length) {
    console.error(`\nFAIL (--check): ${violations.join('; ')}`);
    process.exit(1);
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

function renderMd(sc) {
  const L = [];
  L.push(`# Retrieval-quality scorecard — search_knowledge`);
  L.push('');
  L.push(`Generated: ${sc.generated_at}  `);
  L.push(`Daemon: \`${sc.daemon}\`  `);
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

main().catch((e) => { console.error(e.stack || e.message); process.exit(1); });
