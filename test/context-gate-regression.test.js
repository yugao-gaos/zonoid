#!/usr/bin/env node
// 9-case ground-truth regression suite for the context-need gate (lib/context-gate.js).
// Run: node test/context-gate-regression.test.js — exits non-zero if RECALL < 1.0.
//
// SLOW + environment-dependent: prefers REAL semantic scoring (MiniLM via lib/embed.js — lazy-loaded,
// the first call can take ~10-90s while the model loads/downloads) over the LIVE workspace overlay
// (the actual KB note nodes + vectors for ZONOID_WORKSPACE). If either the model or the
// overlay is unavailable the suite SKIPS gracefully (exit 0 with a loud warning) — the thresholds are
// calibrated for the semantic path, so a lexical-fallback grade would be meaningless.
//
// GROUND TRUTH (n=9, from the held-out arc — bench/heldout/specs/*.md + bench/report-phase1.md):
//   INJECT (a project-local note measurably flipped the outcome):
//     task-transcript — note-mq7kyiir6sx (~40% of assignee records carry no session; byWindow overlap)
//     locale-sum      — note-mq7ydrv353p (feed mixes en-US/de-DE decimals; Number() silently mis-sums)
//   ABSTAIN (cold solved every held-out edge case — the needed facts are in the pretraining prior,
//   or no applicable note exists):
//     native-store, claim-task, wt-gc, tls-local, ctl-loop-next, ctl-stale-claims, ctl-agg-report
//
// PASS RULE — error costs are asymmetric (bench/context-gate-eval.md):
//   recall < 1.0  → FAIL (a false-abstain is a missed win = a failed task; non-negotiable)
//   precision < 1.0 → WARN only (a false-inject costs the bounded over-deliberation tax)
//
// HONEST CAVEAT: n=9 with 2 positives. The locality threshold (>= 2 of 4 categories) separates this
// set with a one-category margin on each side (winners 3-4, pretraining-prior FPs 0-1), but it is
// calibrated, not validated — new positives should be added here as they accrue.
'use strict';

const fs = require('fs');
const path = require('path');
const { gateTask } = require('../lib/context-gate');
const { embed, cosine } = require('../lib/embed');
const overlay = require('../lib/overlay');

if (process.env.ZONOID_SKIP_LIVE) { console.log('SKIP  context-gate regression suite: ZONOID_SKIP_LIVE set'); process.exit(0); }
const WORKSPACE = process.env.ZONOID_WORKSPACE || '';
if (!WORKSPACE) { console.log('SKIP  context-gate regression suite: set ZONOID_WORKSPACE=/path/to/workspace'); process.exit(0); }
const SPECS = path.join(__dirname, '..', 'bench', 'heldout', 'specs');

// case id -> expected gate decision (ground truth from the held-out arc; see header).
const CASES = [
  { name: 'task-transcript', want: 'inject' },
  { name: 'locale-sum', want: 'inject' },
  { name: 'native-store', want: 'abstain' },
  { name: 'claim-task', want: 'abstain' },
  { name: 'wt-gc', want: 'abstain' },
  { name: 'tls-local', want: 'abstain' },
  { name: 'ctl-loop-next', want: 'abstain' },
  { name: 'ctl-stale-claims', want: 'abstain' },
  { name: 'ctl-agg-report', want: 'abstain' },
];

function skip(why) {
  console.log(`SKIP  context-gate regression suite: ${why}`);
  console.log('      (semantic scoring required — thresholds are calibrated for MiniLM cosines;');
  console.log('       a lexical-fallback grade would not be meaningful)');
  process.exit(0);
}

(async () => {
  // Live KB note nodes with vectors, via lib/overlay.js.
  let notes = [];
  try {
    const o = overlay.load(WORKSPACE);
    const nn = (o && o.note_nodes) || {};
    notes = Object.keys(nn).filter((k) => Array.isArray(nn[k].vec))
      .map((k) => ({ key: k, title: nn[k].title, summary: nn[k].summary, vec: nn[k].vec }));
  } catch (e) { /* fall through to the emptiness check */ }
  if (notes.length === 0) skip(`no embedded note nodes in overlay for ${WORKSPACE}`);

  // Semantic path required (see header). Probe once; the model lazy-loads here.
  const probe = await embed('context gate regression probe');
  if (!Array.isArray(probe)) skip('embedding model unavailable (lib/embed.js returned null)');

  let tp = 0, fn = 0, fp = 0, tn = 0;
  const rows = [];
  for (const c of CASES) {
    const spec = fs.readFileSync(path.join(SPECS, c.name + '.md'), 'utf8');
    const label = (spec.match(/^#\s*(.+)$/m) || [, c.name])[1];
    const r = await gateTask({ label, spec }, notes, { embedQuery: embed, cosine });
    const correct = r.decision === c.want;
    if (c.want === 'inject') { if (r.decision === 'inject') tp++; else fn++; }
    else { if (r.decision === 'inject') fp++; else tn++; }
    rows.push({ ...c, ...r, correct });
    console.log(`${correct ? 'PASS' : 'FAIL'}  ${c.name.padEnd(17)} want=${c.want.padEnd(7)} got=${r.decision.padEnd(7)}`
      + ` top1=${r.top1} margin=${r.margin} gap=${r.gap} locality=${r.locality} type=${r.topType}`
      + ` top=${r.topKey} reason=${r.reason}`);
  }

  const recall = tp / (tp + fn);
  const precision = tp + fp === 0 ? 1 : tp / (tp + fp);
  console.log('-----');
  console.log('confusion matrix (rows = ground truth, cols = gate):');
  console.log(`              INJECT  ABSTAIN`);
  console.log(`  needs-note  TP=${tp}    FN=${fn}`);
  console.log(`  no-note     FP=${fp}    TN=${tn}`);
  console.log(`recall=${recall.toFixed(2)} precision=${precision.toFixed(2)}  (n=9: 2 positives, 7 negatives — calibration set, not validation)`);

  if (recall < 1) {
    console.log(`FAIL: recall ${recall.toFixed(2)} < 1.0 — the gate ABSTAINED on a known win (the expensive error).`);
    process.exit(1);
  }
  if (precision < 1) {
    console.log(`WARN: precision ${precision.toFixed(2)} < 1.0 — false-injects pay the bounded over-deliberation tax (not fatal).`);
  }
  console.log(`${rows.filter((r) => r.correct).length}/${rows.length} cases correct; recall 1.0 — suite passes.`);
  process.exit(0);
})().catch((e) => { console.error('ERROR running regression suite:', e && e.message); process.exit(1); });
