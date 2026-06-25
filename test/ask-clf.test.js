#!/usr/bin/env node
// Plain Node test (no framework; matches test/ask-gate.test.js style) for the learned ask-gate (T3):
//   1. FIT: ask-clf-fit.js trains on a seed journal → writes .graph/ask-clf/v1.json + metrics row,
//      and DEGRADES (skip, no model) on a sparse / missing / single-class journal.
//   2. SHADOW: askGate attaches shadow_decision/shadow_conf from the learned model WITHOUT changing
//      the live (heuristic) decision while mode = heuristic.
//   3. PROMOTE: the comparator flips live source heuristic→learned when learned beats heuristic over
//      a stable window — and stays heuristic when learned is worse.
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const FIT = path.join(ROOT, 'scripts', 'ask-clf-fit.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

function tmpdir() { return fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ask-clf-'))); }

// Run ask-clf-fit.js against an isolated journal + model dir via env overrides.
function runFit(journalPath, clfDir) {
  return spawnSync(process.execPath, [FIT], {
    cwd: ROOT, encoding: 'utf8',
    env: { ...process.env, ASK_JOURNAL_PATH: journalPath, ASK_CLF_DIR: clfDir },
  });
}

// Build a seed journal row. `correct` = was the heuristic decision right (ground truth).
// High-signal rows (top1/margin/gap/locality high, empirical) → the right call is PREDICT;
// low-signal rows → the right call is ASK. We give the heuristic some wrong calls so a learned
// model fit on the features can BEAT it (predict-was-right vs should-have-asked).
function row(decision, correct, feats) {
  return JSON.stringify({
    ts: new Date().toISOString(), workspace: '/tmp/ws', query: 'q',
    decision, correct, reason: 'r',
    top1: feats.top1, margin: feats.margin, gap: feats.gap, locality: feats.locality,
    tagOverlap: feats.tagOverlap || 0, sharedTags: feats.sharedTags || 0,
    topType: feats.topType || 'empirical', topKey: 'k', via: 'semantic',
    override: false, overrideCategory: null, embedModel: 'Xenova/all-MiniLM-L6-v2',
    gated: true, prefCands: 2,
  });
}

(async () => {
  // ---- 1a. FIT on a seed journal → model + metrics row ----------------------------------------
  {
    const dir = tmpdir();
    const journal = path.join(dir, 'ask-journal.jsonl');
    const clfDir = path.join(dir, 'ask-clf');
    const lines = [];
    // 40 rows. Separable: high features ⇒ label predict(1), low features ⇒ label ask(0).
    for (let i = 0; i < 20; i++) {
      lines.push(row('predict', true, { top1: 0.85, margin: 0.4, gap: 0.5, locality: 3 })); // correct predict → label 1
      lines.push(row('ask', true, { top1: 0.2, margin: 0.02, gap: 0.05, locality: 0 }));     // correct ask → label 0
    }
    fs.writeFileSync(journal, lines.join('\n') + '\n');
    const res = runFit(journal, clfDir);
    ok('fit: exits 0 on seed journal', res.status === 0);
    const modelPath = path.join(clfDir, 'v1.json');
    ok('fit: writes v1.json', fs.existsSync(modelPath));
    const model = JSON.parse(fs.readFileSync(modelPath, 'utf8'));
    ok('fit: model has 7 weights + bias + threshold', Array.isArray(model.weights) && model.weights.length === 7 && typeof model.bias === 'number' && typeof model.threshold === 'number');
    ok('fit: metrics carry learned + heuristic accuracy on same holdout',
       typeof model.metrics.learned_accuracy === 'number' && typeof model.metrics.heuristic_accuracy === 'number');
    ok('fit: learned accuracy is perfect on cleanly separable seed', model.metrics.learned_accuracy >= 0.99);
    const metrics = fs.readFileSync(path.join(clfDir, 'metrics.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    ok('fit: appends one metrics row', metrics.length === 1 && metrics[0].skipped !== true);

    // The trained model, loaded by the predictor, predicts PREDICT on a high-signal feature vector.
    delete require.cache[require.resolve('../scripts/ask-clf-predict')];
    const clf = require('../scripts/ask-clf-predict');
    const hi = clf.predict({ top1: 0.85, margin: 0.4, gap: 0.5, locality: 3, topType: 'empirical' }, modelPath);
    const lo = clf.predict({ top1: 0.2, margin: 0.02, gap: 0.05, locality: 0, topType: 'note' }, modelPath);
    ok('predict: high-signal → predict', hi && hi.decision === 'predict');
    ok('predict: low-signal → ask', lo && lo.decision === 'ask');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- 1b. DEGRADE: sparse / missing / single-class → skip, no model --------------------------
  {
    const dir = tmpdir();
    const clfDir = path.join(dir, 'ask-clf');
    // missing journal
    const r1 = runFit(path.join(dir, 'nope.jsonl'), clfDir);
    ok('degrade: missing journal exits 0, no model', r1.status === 0 && !fs.existsSync(path.join(clfDir, 'v1.json')));
    ok('degrade: missing journal logs skip row', /skip/.test(r1.stdout));

    // sparse (< MIN_LABELED labeled rows)
    const sparse = path.join(dir, 'sparse.jsonl');
    fs.writeFileSync(sparse, [row('predict', true, { top1: 0.8, margin: 0.4, gap: 0.5, locality: 3 })].join('\n') + '\n');
    const r2 = runFit(sparse, clfDir);
    ok('degrade: sparse journal exits 0, no model', r2.status === 0 && !fs.existsSync(path.join(clfDir, 'v1.json')));

    // single-class (enough rows but all label 1)
    const single = path.join(dir, 'single.jsonl');
    fs.writeFileSync(single, Array.from({ length: 15 }, () => row('predict', true, { top1: 0.8, margin: 0.4, gap: 0.5, locality: 3 })).join('\n') + '\n');
    const r3 = runFit(single, clfDir);
    ok('degrade: single-class exits 0, no model', r3.status === 0 && !fs.existsSync(path.join(clfDir, 'v1.json')));

    // unlabeled rows (no `correct`) are excluded → treated as insufficient data.
    const unl = path.join(dir, 'unlabeled.jsonl');
    fs.writeFileSync(unl, Array.from({ length: 15 }, () => JSON.stringify({ decision: 'ask', top1: 0.2, margin: 0, gap: 0, locality: 0 })).join('\n') + '\n');
    const r4 = runFit(unl, clfDir);
    ok('degrade: unlabeled-only journal skips (no fabricated labels)', r4.status === 0 && !fs.existsSync(path.join(clfDir, 'v1.json')));
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- 2. SHADOW: learned prediction attached, heuristic stays live ---------------------------
  {
    const dir = tmpdir();
    const clfDir = path.join(dir, 'ask-clf');
    // Train a model first so the gate has something to shadow with.
    const journal = path.join(dir, 'ask-journal.jsonl');
    const lines = [];
    for (let i = 0; i < 20; i++) {
      lines.push(row('predict', true, { top1: 0.85, margin: 0.4, gap: 0.5, locality: 3 }));
      lines.push(row('ask', true, { top1: 0.2, margin: 0.02, gap: 0.05, locality: 0 }));
    }
    fs.writeFileSync(journal, lines.join('\n') + '\n');
    runFit(journal, clfDir);
    const modelPath = path.join(clfDir, 'v1.json');

    delete require.cache[require.resolve('../scripts/ask-clf-predict')];
    delete require.cache[require.resolve('../lib/ask-promote')];
    delete require.cache[require.resolve('../lib/ask-gate')];
    const { askGate } = require('../lib/ask-gate');

    const fakeCosine = (_q, v) => (Array.isArray(v) ? v[0] : 0);
    const fakeEmbed = async () => [1];
    // A LOW-confidence decision: heuristic decides ASK. mode defaults heuristic (no mode.json).
    const notes = [{ key: 'n1', title: 't', summary: 'general note', vec: [0.40] }, { key: 'n2', title: 'o', summary: 'x', vec: [0.20] }];
    const r = await askGate('some pending decision', notes, { embedQuery: fakeEmbed, cosine: fakeCosine, modelPath });
    ok('shadow: live decision stays heuristic (ask) while mode=heuristic', r.decision === 'ask' && r.source === 'heuristic');
    ok('shadow: shadow_decision attached', r.shadow_decision === 'ask' || r.shadow_decision === 'predict');
    ok('shadow: shadow_conf is a number', typeof r.shadow_conf === 'number');

    // Flip the mode to learned and confirm the LIVE decision switches to the learned model's call.
    // Use a degenerate model (bias huge → always predict) so the flip is observable on a low-conf
    // decision the heuristic would ASK.
    fs.writeFileSync(modelPath, JSON.stringify({
      version: 'v1', features: ['top1', 'margin', 'gap', 'locality', 'tag_overlap', 'shared_tags', 'is_empirical'],
      weights: [0, 0, 0, 0, 0, 0, 0], bias: 10, threshold: 0.5,
    }));
    fs.writeFileSync(path.join(clfDir, 'mode.json'), JSON.stringify({ source: 'learned' }));
    delete require.cache[require.resolve('../scripts/ask-clf-predict')];
    delete require.cache[require.resolve('../lib/ask-promote')];
    delete require.cache[require.resolve('../lib/ask-gate')];
    const { askGate: askGate2 } = require('../lib/ask-gate');
    const r2 = await askGate2('some pending decision', notes, { embedQuery: fakeEmbed, cosine: fakeCosine, modelPath, modeDir: clfDir });
    ok('flip: live source = learned', r2.source === 'learned');
    ok('flip: live decision switches to learned (predict)', r2.decision === 'predict');
    ok('flip: heuristic_decision preserved (ask)', r2.heuristic_decision === 'ask');
    fs.rmSync(dir, { recursive: true, force: true });
  }

  // ---- 3. PROMOTE: comparator flips source when learned beats heuristic, else stays -----------
  {
    delete require.cache[require.resolve('../lib/promotion')];
    delete require.cache[require.resolve('../lib/ask-promote')];
    const { evaluate } = require('../lib/promotion');
    const askPromote = require('../lib/ask-promote');

    // 3a. learned beats heuristic over a stable window → promote.
    const win = [
      { challenger: 0.80, incumbent: 0.70 },
      { challenger: 0.82, incumbent: 0.71 },
      { challenger: 0.85, incumbent: 0.70 },
    ];
    ok('comparator: stable margin → promote', evaluate(win, { window: 3, margin: 0.02 }).promote === true);

    // 3b. learned worse → stay heuristic.
    const lose = [
      { challenger: 0.60, incumbent: 0.70 },
      { challenger: 0.62, incumbent: 0.71 },
      { challenger: 0.65, incumbent: 0.70 },
    ];
    ok('comparator: learned worse → no promote', evaluate(lose, { window: 3, margin: 0.02 }).promote === false);

    // 3c. one good cycle inside a noisy window → no promote (stability guard).
    const noisy = [
      { challenger: 0.60, incumbent: 0.70 },
      { challenger: 0.85, incumbent: 0.70 },
      { challenger: 0.62, incumbent: 0.70 },
    ];
    ok('comparator: single lucky cycle does not promote', evaluate(noisy, { window: 3, margin: 0.02 }).promote === false);

    // 3d. insufficient window → no promote.
    ok('comparator: insufficient window → no promote', evaluate([win[0]], { window: 3 }).promote === false);

    // 3e. end-to-end: runComparator reads metrics.jsonl, flips mode.json, and ask-gate reads 'learned'.
    const dir = tmpdir();
    const clfDir = path.join(dir, 'ask-clf');
    fs.mkdirSync(clfDir, { recursive: true });
    const metrics = path.join(clfDir, 'metrics.jsonl');
    fs.writeFileSync(metrics, win.map((s, i) => JSON.stringify({
      version: 'v1', trained_at: new Date(Date.now() + i).toISOString(),
      learned_accuracy: s.challenger, heuristic_accuracy: s.incumbent, n_train: 30, n_holdout: 8,
    })).join('\n') + '\n');
    ok('runComparator: mode starts heuristic', askPromote.readMode(clfDir) === 'heuristic');
    const v = askPromote.runComparator({ dir: clfDir, window: 3, margin: 0.02 });
    ok('runComparator: promotes', v.promote === true && v.mode === 'learned');
    ok('runComparator: persists mode.json=learned', askPromote.readMode(clfDir) === 'learned');
    ok('runComparator: monotone latch (already-learned)', askPromote.runComparator({ dir: clfDir, window: 3, margin: 0.02 }).reason === 'already-learned');

    // 3f. losing metrics → mode stays heuristic.
    const dir2 = tmpdir();
    const clfDir2 = path.join(dir2, 'ask-clf');
    fs.mkdirSync(clfDir2, { recursive: true });
    fs.writeFileSync(path.join(clfDir2, 'metrics.jsonl'), lose.map((s) => JSON.stringify({
      learned_accuracy: s.challenger, heuristic_accuracy: s.incumbent,
    })).join('\n') + '\n');
    const v2 = askPromote.runComparator({ dir: clfDir2, window: 3, margin: 0.02 });
    ok('runComparator: stays heuristic when learned worse', v2.promote === false && askPromote.readMode(clfDir2) === 'heuristic');
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})().catch((e) => { console.error('ERROR:', e && (e.stack || e.message)); process.exit(1); });
