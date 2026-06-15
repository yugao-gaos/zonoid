'use strict';
// Pure reader over the append-only judge verdict journal (.graph/judge-journal.jsonl).
//
// Each line is one judge verdict (keep|prune|markJudged|consolidate|surface) written at the moment
// the daemon applied it; the `cosine` field is the edge's creation score (for autowire edges, the
// seeded recall score/weight). This file is what a future threshold re-tune consumes: it recovers the
// per-cosine-band keep-vs-prune rate that was previously unrecoverable (prunes deleted the edge with
// no trace). Read + bucket only — no daemon state, no HTTP, no filesystem writes.
//
// Schema v2 optional fields (added 2026-06-15; absent on legacy rows — treat missing as null):
//   shadow_verdict  — learned-model verdict ("keep"|"prune") in shadow mode before enforcement.
//   shadow_conf     — learned-model confidence 0.0–1.0.
//   model_version   — model identifier that produced shadow_verdict, e.g. "sonnet-4-6".
// These fields are ignored by all existing bucket/rate functions (backward-compatible reads).
const fs = require('fs');
const path = require('path');

// Default cosine bands for keepRateByBand. Half-open [lo, hi); the last band is open-ended (0.50+).
const DEFAULT_BANDS = [
  [0.25, 0.30], [0.30, 0.35], [0.35, 0.40], [0.40, 0.45], [0.45, 0.50], [0.50, Infinity],
];

// Read every verdict row from the journal under `ws`. Tolerant: a missing file → [], blank/corrupt
// lines are skipped (the journal is append-only and may be torn on the final line after a crash).
function readVerdicts(ws) {
  const file = path.join(ws, '.graph', 'judge-journal.jsonl');
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); }
  catch { return []; }                                   // no journal yet
  const out = [];
  for (const line of raw.split('\n')) {
    const s = line.trim();
    if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip torn/corrupt line */ }
  }
  return out;
}

function bandLabel([lo, hi]) {
  return hi === Infinity ? `${lo.toFixed(2)}+` : `${lo.toFixed(2)}-${hi.toFixed(2)}`;
}

// Bucket keep/prune verdicts by the edge's cosine into `bands` and return per-band keep rate.
// Only edge-level keep/prune verdicts with a numeric cosine count (markJudged/consolidate/surface are
// note/cluster verdicts with no single edge cosine — they're ignored here). Returns an array aligned
// to `bands`: { band, lo, hi, kept, pruned, total, keepRate } where keepRate is kept/(kept+pruned)
// (null when the band is empty).
//
// opts.origin (string | array): when set, count ONLY verdicts whose `origin` matches (an array is an
// allow-list). This is what isolates the threshold-gated population: live data showed the sub-0.40 KEEP
// band was entirely hand-ASSERTED note->task edges (origin:'asserted'), never the lexical autowire path
// the threshold actually gates — folding them together corrupts the tuning curve. Rows missing `origin`
// (pre-stamping journals) match nothing when a filter is given. Pure over (ws, bands, opts).
function keepRateByBand(ws, bands = DEFAULT_BANDS, opts = {}) {
  const allow = opts.origin == null ? null
    : new Set(Array.isArray(opts.origin) ? opts.origin : [opts.origin]);
  const buckets = bands.map(([lo, hi]) => ({ band: bandLabel([lo, hi]), lo, hi, kept: 0, pruned: 0 }));
  for (const v of readVerdicts(ws)) {
    if (v.verdict !== 'keep' && v.verdict !== 'prune') continue;
    if (allow && !allow.has(v.origin)) continue;
    const c = v.cosine;
    if (typeof c !== 'number' || Number.isNaN(c)) continue;
    const b = buckets.find((x) => c >= x.lo && c < x.hi);
    if (!b) continue;
    if (v.verdict === 'keep') b.kept++; else b.pruned++;
  }
  return buckets.map((b) => {
    const total = b.kept + b.pruned;
    return { band: b.band, lo: b.lo, hi: b.hi, kept: b.kept, pruned: b.pruned, total,
      keepRate: total ? b.kept / total : null };
  });
}

// Convenience: the keep/prune curve for ONLY the threshold-gated population (origin:'autowire-lexical'),
// the one keepRateByBand was built to inform. This is what a DEFAULT_AUTOWIRE_THRESHOLD re-tune reads.
function keepRateByBandAutowireLexical(ws, bands = DEFAULT_BANDS) {
  return keepRateByBand(ws, bands, { origin: 'autowire-lexical' });
}

// Per-origin kept/pruned breakdown across ALL edge verdicts (no cosine banding). Returns a map
// { [origin]: { kept, pruned, total, keepRate } } with rows missing `origin` bucketed under 'unknown'.
// Lets a tuner see, at a glance, how much of the keep/prune signal came from each creation path.
function keepRateByOrigin(ws) {
  const out = {};
  for (const v of readVerdicts(ws)) {
    if (v.verdict !== 'keep' && v.verdict !== 'prune') continue;
    const o = v.origin || 'unknown';
    const b = out[o] || (out[o] = { kept: 0, pruned: 0 });
    if (v.verdict === 'keep') b.kept++; else b.pruned++;
  }
  for (const o of Object.keys(out)) {
    const b = out[o];
    b.total = b.kept + b.pruned;
    b.keepRate = b.total ? b.kept / b.total : null;
  }
  return out;
}

module.exports = { readVerdicts, keepRateByBand, keepRateByBandAutowireLexical, keepRateByOrigin, DEFAULT_BANDS };
