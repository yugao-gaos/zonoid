#!/usr/bin/env node
// bench-learning-journal.js — reducer that pairs ON/OFF bench arms into cost-aware training rows.
//
// Reads bench/heldout/results-heldout.jsonl, groups rows by (candidate, trial), pairs the on-arm
// row with the off-arm row, and emits one PAIRED learning row per (candidate, trial) to
// bench/heldout/learning-journal.jsonl.
//
// The paired row contains:
//   solved_delta   = (on.solved?1:0) - (off.solved?1:0)   — did KB help capability?
//   cost_delta_output = on.output_tokens - off.output_tokens  — did KB cost or SAVE tokens?
//
// λ is NOT baked in here — the trainer applies it downstream.
//
// Usage:
//   node scripts/bench-learning-journal.js [--results <path>] [--out <path>]
//
// Env overrides (also accepted by tests):
//   BENCH_RESULTS_PATH   path to results-heldout.jsonl
//   BENCH_JOURNAL_PATH   path to learning-journal.jsonl output
'use strict';

const fs = require('fs');
const path = require('path');

const REPO = process.env.ZONOID_REPO || path.resolve(__dirname, '..');

// ── CLI / env overrides ───────────────────────────────────────────────────────
function getArg(flag, def) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const RESULTS_PATH = process.env.BENCH_RESULTS_PATH ||
  getArg('--results', path.join(REPO, 'bench', 'heldout', 'results-heldout.jsonl'));
const OUT_PATH = process.env.BENCH_JOURNAL_PATH ||
  getArg('--out', path.join(REPO, 'bench', 'heldout', 'learning-journal.jsonl'));

// ── JSONL helpers (same style as gate-label.js) ───────────────────────────────
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split('\n')
    .filter((l) => l.trim())
    .map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean);
}

// ── Parse gate decision from a gated search_knowledge tool result ─────────────
// Scans a JSONL transcript file and returns the first gated search_knowledge result:
//   { decision, reason, top1, margin, gap, locality, topType, via }
// Returns null if no gated result is found, or on any read error.
function parseGateDecision(transcriptPath) {
  if (!transcriptPath || typeof transcriptPath !== 'string') return null;
  try {
    if (!fs.existsSync(transcriptPath)) return null;
    const lines = fs.readFileSync(transcriptPath, 'utf8').split('\n').filter((l) => l.trim());
    for (const line of lines) {
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      const msg = obj && obj.message;
      const content = msg && msg.content;
      if (!Array.isArray(content)) continue;
      for (const block of content) {
        if (!block || block.type !== 'tool_result') continue;
        const parts = block.content;
        if (!Array.isArray(parts)) continue;
        for (const part of parts) {
          if (!part || part.type !== 'text') continue;
          const text = part.text;
          if (!text || typeof text !== 'string') continue;
          // Must contain "gated":true AND a decision field
          if (!text.includes('"gated"') || !text.includes('"decision"')) continue;
          let parsed;
          try { parsed = JSON.parse(text); } catch { continue; }
          // Confirm it's actually a gated search result
          if (!parsed.gated) continue;
          if (!parsed.decision) continue;
          return {
            decision: parsed.decision,
            reason: parsed.reason || null,
            top1: parsed.top1 != null ? parsed.top1 : null,
            margin: parsed.margin != null ? parsed.margin : null,
            gap: parsed.gap != null ? parsed.gap : null,
            locality: parsed.locality != null ? parsed.locality : null,
            topType: parsed.topType || null,
            via: parsed.via || null,
          };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

// ── Reducer: group, pair, emit ────────────────────────────────────────────────
function reduce(resultsPath, outPath) {
  const rows = readJsonl(resultsPath);

  // Group by (candidate, trial). When multiple on-arms exist (different consult modes),
  // prefer 'gated' consult (the one the gate-learner is trained on), then fall back to
  // first on-arm found.
  const groups = new Map(); // key → { candidate, trial, on: row|null, off: row|null }

  for (const row of rows) {
    const key = `${row.candidate}|||${row.trial}`;
    if (!groups.has(key)) {
      groups.set(key, { candidate: row.candidate, trial: row.trial, on: null, off: null });
    }
    const g = groups.get(key);
    if (row.arm === 'off') {
      g.off = row;
    } else if (row.arm === 'on') {
      // Prefer gated consult; otherwise prefer first seen
      if (!g.on || row.consult === 'gated') {
        g.on = row;
      }
    }
  }

  const output = [];
  let pairedCount = 0;
  let unpairedCount = 0;

  // Distribution accumulators
  const solvedDeltaDist = { '-1': 0, '0': 0, '1': 0 };
  const costDeltaBuckets = { saved: 0, same: 0, cost: 0 };

  for (const g of groups.values()) {
    const { candidate, trial, on, off } = g;

    if (!on || !off) {
      // Partial pair — emit with paired:false
      const missing = !on ? 'on' : 'off';
      const presentRow = on || off;
      output.push(JSON.stringify({
        candidate,
        trial,
        consult: on ? on.consult : null,
        model: presentRow ? presentRow.model : null,
        paired: false,
        missing,
      }) + '\n');
      unpairedCount++;
      continue;
    }

    // Parse gate decision from the on-arm transcript (prefer journalPath, fall back to transcriptPath)
    const transcriptSource = on.journalPath || on.transcriptPath || null;
    const gate = on.consult === 'gated' ? parseGateDecision(transcriptSource) : null;

    const onSolved = on.solved ? 1 : 0;
    const offSolved = off.solved ? 1 : 0;
    const solvedDelta = onSolved - offSolved;
    const costDeltaOutput = (on.outputTokens || 0) - (off.outputTokens || 0);

    // Track distributions
    const sdKey = String(solvedDelta);
    if (sdKey in solvedDeltaDist) solvedDeltaDist[sdKey]++;
    if (costDeltaOutput < 0) costDeltaBuckets.saved++;
    else if (costDeltaOutput === 0) costDeltaBuckets.same++;
    else costDeltaBuckets.cost++;

    output.push(JSON.stringify({
      candidate,
      trial,
      consult: on.consult,
      model: on.model,
      on: {
        solved: on.solved,
        output_tokens: on.outputTokens || 0,
        total_tokens: on.totalTokens || 0,
        gate,
      },
      off: {
        solved: off.solved,
        output_tokens: off.outputTokens || 0,
        total_tokens: off.totalTokens || 0,
      },
      solved_delta: solvedDelta,
      cost_delta_output: costDeltaOutput,
      paired: true,
    }) + '\n');
    pairedCount++;
  }

  // Write output (full rebuild — idempotent)
  fs.mkdirSync(path.dirname(outPath), { recursive: true });
  fs.writeFileSync(outPath, output.join(''), 'utf8');

  // Summary
  const totalGroups = groups.size;
  console.log('');
  console.log('=== bench-learning-journal.js summary ===');
  console.log(`Results file:          ${resultsPath}`);
  console.log(`Output file:           ${outPath}`);
  console.log(`Total (candidate,trial) groups: ${totalGroups}`);
  console.log(`Paired rows emitted:   ${pairedCount}`);
  console.log(`Unpaired rows skipped: ${unpairedCount}`);
  if (pairedCount > 0) {
    console.log(`solved_delta distribution:  -1=${solvedDeltaDist['-1']}  0=${solvedDeltaDist['0']}  +1=${solvedDeltaDist['1']}`);
    console.log(`cost_delta_output:  KB-saved=${costDeltaBuckets.saved}  same=${costDeltaBuckets.same}  KB-cost=${costDeltaBuckets.cost}`);
  }
  console.log('');

  return { totalGroups, pairedCount, unpairedCount };
}

// ── Exports (for tests) ───────────────────────────────────────────────────────
module.exports = { readJsonl, parseGateDecision, reduce };

// ── Main guard ────────────────────────────────────────────────────────────────
if (require.main === module) {
  try {
    reduce(RESULTS_PATH, OUT_PATH);
  } catch (e) {
    console.error('bench-learning-journal ERROR:', e && (e.stack || e.message));
    process.exit(1);
  }
}
