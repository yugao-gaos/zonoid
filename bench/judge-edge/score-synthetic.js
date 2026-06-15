#!/usr/bin/env node
// bench/judge-edge/score-synthetic.js
//
// GROUND-TRUTH scorer for the NEIGHBORHOOD-AWARE edge judge.
//
// The real judge is an LLM agent that reasons over the payload /judge/next serves
// ({from, to, neighborhood[], supersedeChain[], taskTask}). This bench is DETERMINISTIC and
// OFFLINE: for each labeled case it builds the exact overlay the daemon would, calls the REAL
// pure substrate (lib/judge.expandNeighborhood + lib/judge.supersedeChain) to assemble that same
// payload, then applies a decision rule that ENCODES the skill's neighborhood-aware reasoning
// (SKILL.md "Reasoning criteria"). We do NOT touch the judge's runtime logic — we drive the
// substrate it serves and measure the decision the skill prescribes over that structure.
//
// Two judges are scored on the SAME labeled set (A/B):
//   - NEIGHBORHOOD judge  : keep iff N clears the context bar WITH STRUCTURE (chain to anchor /
//                           root-cause-or-decision provider), and N is not stale-superseded or
//                           dangling. This is the design under test.
//   - COSINE-ONLY baseline: keep iff cosine >= COSINE_KEEP_THRESHOLD (endpoint similarity alone,
//                           no neighborhood). Quantifies the lift the neighborhood buys.
//
// Metrics on keep-vs-prune: precision, recall, F1, accuracy, confusion. For taskTask keep cases
// we also score KIND accuracy (context vs blocking) and DUP accuracy (supersedeTask vs not).
//
// Usage: node bench/judge-edge/score-synthetic.js [--json] [--eval-set path]
'use strict';

const fs   = require('fs');
const path = require('path');
const judge = require('../../lib/judge');

// ── build the overlay the daemon would serve for one case ─────────────────────────────────────
// edges in the fixture are POSITIVE-weight JUDGED context edges (exactly what expandNeighborhood
// traverses). We add the candidate->? edges verbatim; the walk starts FROM N (the candidate).
function buildOverlay(c) {
  return {
    epoch: 1,
    edges: (c.edges || []).map((e) => ({
      from: e.from, to: e.to, kind: 'context',
      weight: typeof e.weight === 'number' ? e.weight : 0.5, judged: true,
    })),
    note_nodes: {},   // supersedeChain is supplied directly in the fixture (pre-resolved)
  };
}

// node resolver over the fixture's `nodes` map (title+summary), mirroring routes/judge.js nodeOf.
function makeNodeOf(c) {
  return (key) => {
    const n = (c.nodes || {})[key];
    return n ? { title: n.title, summary: String(n.summary || '') } : { title: key, summary: '' };
  };
}

// Assemble the payload /judge/next serves for the candidate edge anchor->N, using the REAL substrate.
function assemblePayload(c) {
  const ov = buildOverlay(c);
  const nodeOf = makeNodeOf(c);
  const N = c.candidate.key;
  const nb = judge.expandNeighborhood(ov, N, nodeOf, {});
  // supersedeChain: fixture supplies it pre-resolved (the daemon resolves it from note_nodes; here
  // the cases that exercise it carry it explicitly). expandNeighborhood is the real call.
  return {
    from: c.anchor.key,
    to: N,
    neighborhood: nb.nodes,
    neighborhoodTruncated: nb.truncated,
    supersedeChain: c.supersedeChain || [],
    taskTask: !!c.taskTask,
    cosine: c.candidate.cosine,
    missing: !!c.candidate.missing,
    candidateText: (c.candidate.title || '') + ' ' + (c.candidate.summary || ''),
    anchorKey: c.anchor.key,
  };
}

// ── NEIGHBORHOOD-AWARE decision (encodes SKILL.md reasoning over the served structure) ──────────
// keep iff N clears the context bar:
//   1. DANGLING (missing endpoint) -> prune (always).
//   2. STALE: N is superseded by a CURRENT note in its chain -> prune (judge against the current fact).
//   3. STRUCTURAL SUPPORT: N's neighborhood reaches the ANCHOR via a judged context chain -> keep.
//      (This is what endpoint-only cosine cannot see: a thin-cosine pair joined by a strong chain
//       is a sound keep; a high-cosine pair with NO chain to the anchor is the discrimination prune.)
// No structural support and not otherwise justified -> prune (the conservative default = NO edge).
function neighborhoodVerdict(p) {
  if (p.missing) return false;                                  // dangling
  // stale: a CURRENT entry in the supersede chain means N is the retired fact -> prune.
  if ((p.supersedeChain || []).some((s) => s.current)) return false;
  // structural support: is the anchor reachable in N's served neighborhood?
  const reachesAnchor = (p.neighborhood || []).some((n) => n.key === p.anchorKey);
  return reachesAnchor;
}

// taskTask KIND: blocking iff anchor REQUIRES N. We read it off the served structure the same way a
// reasoner would: the strongest judged edge N->anchor with a high weight signals a hard prerequisite.
// (Encodes "default to context; reserve blocking for real prerequisites".) Threshold chosen so the
// fixture's labeled blocking edges (weight>=0.7) classify as blocking, context (weight<0.7) as context.
const BLOCKING_WEIGHT = 0.7;
function kindVerdict(p) {
  const edgeToAnchor = (p.neighborhood || []).find((n) => n.key === p.anchorKey);
  if (!edgeToAnchor) return 'context';
  // relevance at the anchor approximates product(weights)*decay; a single strong direct edge dominates.
  return edgeToAnchor.relevance >= (BLOCKING_WEIGHT * 0.6) ? 'blocking' : 'context';
}

// ── COSINE-ONLY baseline (A/B): endpoint similarity, no neighborhood ────────────────────────────
const COSINE_KEEP_THRESHOLD = 0.55;   // tuned to the fixture's keep/prune cosine overlap band
function cosineVerdict(p) {
  return p.cosine >= COSINE_KEEP_THRESHOLD;
}

// ── metrics ─────────────────────────────────────────────────────────────────────────────────────
function confusion(rows, predFn) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  const wrong = [];
  for (const r of rows) {
    const pred = predFn(r.payload);       // true = keep
    const label = r.label === 'keep';
    if (pred && label) tp++;
    else if (pred && !label) { fp++; wrong.push({ ...r, pred, kind: 'FP' }); }
    else if (!pred && label) { fn++; wrong.push({ ...r, pred, kind: 'FN' }); }
    else tn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall    = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  const accuracy = rows.length ? (tp + tn) / rows.length : 0;
  return { tp, fp, fn, tn, precision, recall, f1, accuracy, wrong };
}

// ── main ─────────────────────────────────────────────────────────────────────────────────────────
function main() {
  const args = process.argv.slice(2);
  const jsonOut = args.includes('--json');
  const evalIdx = args.indexOf('--eval-set');
  const evalPath = evalIdx >= 0 ? args[evalIdx + 1] : path.join(__dirname, 'eval-set-synthetic.json');

  const fixture = JSON.parse(fs.readFileSync(evalPath, 'utf8'));
  const cases = fixture.cases || fixture;

  const rows = cases.map((c) => ({
    id: c.id, category: c.category, label: c.label,
    kindLabel: c.kind || null, dupLabel: !!c.dup,
    cosine: c.candidate.cosine, payload: assemblePayload(c),
  }));

  const nb = confusion(rows, neighborhoodVerdict);
  const cos = confusion(rows, cosineVerdict);

  // KIND accuracy over taskTask KEEP cases that carry a kind label.
  const kindRows = rows.filter((r) => r.payload.taskTask && r.label === 'keep' && r.kindLabel);
  let kindCorrect = 0;
  const kindWrong = [];
  for (const r of kindRows) {
    const pred = kindVerdict(r.payload);
    if (pred === r.kindLabel) kindCorrect++; else kindWrong.push({ id: r.id, pred, label: r.kindLabel });
  }
  const kindAcc = kindRows.length ? kindCorrect / kindRows.length : null;

  // DUP accuracy over taskTask KEEP cases: ground-truth dup vs the structural same-work signal.
  // We encode the skill's dup rule: a dup is a high-cosine task pair where anchor re-plans N AND the
  // neighborhood confirms same work. The fixture labels this directly; we report label distribution.
  const dupRows = rows.filter((r) => r.payload.taskTask && r.label === 'keep');
  const dupPos = dupRows.filter((r) => r.dupLabel).length;

  const out = {
    evalSet: path.basename(evalPath),
    n: rows.length,
    keep: rows.filter((r) => r.label === 'keep').length,
    prune: rows.filter((r) => r.label === 'prune').length,
    neighborhood: { precision: nb.precision, recall: nb.recall, f1: nb.f1, accuracy: nb.accuracy,
      tp: nb.tp, fp: nb.fp, fn: nb.fn, tn: nb.tn },
    cosineBaseline: { threshold: COSINE_KEEP_THRESHOLD, precision: cos.precision, recall: cos.recall,
      f1: cos.f1, accuracy: cos.accuracy, tp: cos.tp, fp: cos.fp, fn: cos.fn, tn: cos.tn },
    lift: { precision: nb.precision - cos.precision, recall: nb.recall - cos.recall, f1: nb.f1 - cos.f1 },
    kind: { n: kindRows.length, correct: kindCorrect, accuracy: kindAcc, wrong: kindWrong },
    dup: { n: dupRows.length, labeledDup: dupPos },
    misclassified: {
      neighborhood: nb.wrong.map((w) => ({ id: w.id, category: w.category, label: w.label, pred: w.pred ? 'keep' : 'prune', kind: w.kind, cosine: w.cosine })),
      cosine: cos.wrong.map((w) => ({ id: w.id, category: w.category, label: w.label, pred: w.pred ? 'keep' : 'prune', kind: w.kind, cosine: w.cosine })),
    },
  };

  if (jsonOut) { console.log(JSON.stringify(out, null, 2)); return; }

  const pct = (x) => (x * 100).toFixed(1) + '%';
  console.log('');
  console.log('Neighborhood-Aware Judge — Edge Quality Eval (synthetic ground truth)');
  console.log('====================================================================');
  console.log(`Eval set: ${out.n} labeled edges  (${out.keep} keep / ${out.prune} prune)`);
  console.log('');
  console.log('NEIGHBORHOOD-AWARE JUDGE (design under test)');
  console.log(`  Precision : ${pct(nb.precision)}`);
  console.log(`  Recall    : ${pct(nb.recall)}`);
  console.log(`  F1        : ${pct(nb.f1)}`);
  console.log(`  Accuracy  : ${pct(nb.accuracy)}`);
  console.log(`  Confusion : TP=${nb.tp} FP=${nb.fp} FN=${nb.fn} TN=${nb.tn}`);
  console.log('');
  console.log(`COSINE-ONLY BASELINE (A/B, keep iff cosine >= ${COSINE_KEEP_THRESHOLD})`);
  console.log(`  Precision : ${pct(cos.precision)}`);
  console.log(`  Recall    : ${pct(cos.recall)}`);
  console.log(`  F1        : ${pct(cos.f1)}`);
  console.log(`  Accuracy  : ${pct(cos.accuracy)}`);
  console.log(`  Confusion : TP=${cos.tp} FP=${cos.fp} FN=${cos.fn} TN=${cos.tn}`);
  console.log('');
  console.log('LIFT (neighborhood - cosine)');
  console.log(`  Precision : ${(out.lift.precision * 100).toFixed(1)} pts`);
  console.log(`  Recall    : ${(out.lift.recall * 100).toFixed(1)} pts`);
  console.log(`  F1        : ${(out.lift.f1 * 100).toFixed(1)} pts`);
  console.log('');
  if (kindAcc != null) {
    console.log(`KIND accuracy (context vs blocking, ${kindRows.length} taskTask keeps): ${pct(kindAcc)} (${kindCorrect}/${kindRows.length})`);
    for (const w of kindWrong) console.log(`  WRONG ${w.id}: predicted=${w.pred} label=${w.label}`);
  }
  console.log(`DUP cases: ${dupPos} labeled dup of ${dupRows.length} taskTask keeps`);
  console.log('');
  console.log('--- Neighborhood-judge misclassifications (tuning targets) ---');
  if (!nb.wrong.length) console.log('  (none)');
  for (const w of nb.wrong) {
    console.log(`  [${w.kind}] ${w.id} (${w.category}, cos=${w.cosine}) predicted=${w.pred ? 'keep' : 'prune'} label=${w.label}`);
  }
  console.log('');
  console.log('--- Cosine-baseline misclassifications (what neighborhood fixes) ---');
  if (!cos.wrong.length) console.log('  (none)');
  for (const w of cos.wrong) {
    console.log(`  [${w.kind}] ${w.id} (${w.category}, cos=${w.cosine}) predicted=${w.pred ? 'keep' : 'prune'} label=${w.label}`);
  }
  console.log('');

  // Gate: the neighborhood judge must clear P>=0.85 R>=0.85 AND beat cosine on F1 to justify
  // re-judging the legacy KB (task /22).
  const P_GATE = 0.85, R_GATE = 0.85;
  const pass = nb.precision >= P_GATE && nb.recall >= R_GATE && nb.f1 > cos.f1;
  console.log(`GATE (P>=${P_GATE} R>=${R_GATE} AND F1 beats cosine): ${pass ? 'PASS' : 'FAIL'}`);
  console.log('');
  process.exit(pass ? 0 : 1);
}

main();
