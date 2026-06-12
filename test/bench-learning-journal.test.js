#!/usr/bin/env node
// Tests for scripts/bench-learning-journal.js — the paired learning-journal reducer.
//
// Standalone: no live daemon needed. The reducer reads files only.
// Uses a temp dir with synthetic results-heldout.jsonl and a synthetic transcript.
//
// Covers:
//   1. Paired row: on+off arms present → paired:true, correct solved_delta, cost_delta_output,
//      on.gate parsed from synthetic gated transcript.
//   2. Gate fields: on.gate.decision==='inject', on.gate.top1===0.62.
//   3. solved_delta: on.solved=true, off.solved=false → delta === 1.
//   4. cost_delta_output: on.outputTokens=800, off.outputTokens=1500 → delta === -700 (KB saved).
//   5. Single-arm case: only off row present → paired:false, missing==='on'.
//   6. Non-gated on-arm: gate === null (not a gated consult).
//   7. Idempotency: running reduce() twice produces the same output (full rebuild).
//
// Run: node test/bench-learning-journal.test.js
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const REPO = path.join(__dirname, '..');
const { readJsonl, parseGateDecision, reduce } = require(path.join(REPO, 'scripts', 'bench-learning-journal'));

// ── Test harness ──────────────────────────────────────────────────────────────
let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
};

// ── Temp dir setup ────────────────────────────────────────────────────────────
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-lj-test-'));
const RESULTS = path.join(TMP, 'results-heldout.jsonl');
const OUT = path.join(TMP, 'learning-journal.jsonl');
const JOURNAL_DIR = path.join(TMP, 'journals');
fs.mkdirSync(JOURNAL_DIR, { recursive: true });

// ── Synthetic transcript: a gated search_knowledge result ─────────────────────
// Format mirrors real transcripts: each line is a JSON object with message.content array.
// The gate result is a tool_result block containing the JSON gate payload.
const GATE_PAYLOAD = {
  query: 'test query for overlay persistence',
  gated: true,
  decision: 'inject',
  reason: 'sharp-specific-empirical',
  top1: 0.62,
  margin: 0.15,
  gap: 0.08,
  locality: 2,
  topType: 'empirical',
  via: 'semantic',
  results: [],
};

const SESSION_ON = 'aaaaaaaa-0001-0001-0001-000000000001';
const TRANSCRIPT_PATH = path.join(JOURNAL_DIR, `${SESSION_ON}.jsonl`);

// Synthetic transcript: one line with a tool_result containing the gate payload.
const transcriptLine = JSON.stringify({
  type: 'assistant',
  message: {
    role: 'assistant',
    content: [
      {
        type: 'tool_result',
        tool_use_id: 'fake-tool-use-id',
        content: [
          { type: 'text', text: JSON.stringify(GATE_PAYLOAD) },
        ],
      },
    ],
  },
});
fs.writeFileSync(TRANSCRIPT_PATH, transcriptLine + '\n', 'utf8');

// ── Synthetic results rows ────────────────────────────────────────────────────
const SESSION_OFF = 'bbbbbbbb-0002-0002-0002-000000000002';

const onRow = {
  candidate: 'overlay-save',
  arm: 'on',
  consult: 'gated',
  armLabel: 'on-gated',
  trial: 0,
  sessionId: SESSION_ON,
  transcriptPath: TRANSCRIPT_PATH,
  journalPath: TRANSCRIPT_PATH,  // use the same synthetic transcript
  model: 'sonnet',
  exitCode: 0,
  wallMs: 30000,
  artifactPresent: true,
  diffChars: 500,
  diffTokens: 125,
  inputTokens: 2000,
  outputTokens: 800,
  cacheReadTokens: 0,
  totalTokens: 2800,
  solved: true,
  pass: 5,
  total: 5,
  edgePass: 2,
  edgeTotal: 2,
  gradeError: null,
  cases: [],
};

const offRow = {
  candidate: 'overlay-save',
  arm: 'off',
  consult: null,
  armLabel: 'off',
  trial: 0,
  sessionId: SESSION_OFF,
  transcriptPath: null,
  journalPath: null,
  model: 'sonnet',
  exitCode: 0,
  wallMs: 25000,
  artifactPresent: true,
  diffChars: 400,
  diffTokens: 100,
  inputTokens: 2200,
  outputTokens: 1500,
  cacheReadTokens: 0,
  totalTokens: 3700,
  solved: false,
  pass: 3,
  total: 5,
  edgePass: 0,
  edgeTotal: 2,
  gradeError: null,
  cases: [],
};

// Single-arm case: only an off-arm row for (locale-sum, trial 0)
const offOnlyRow = {
  candidate: 'locale-sum',
  arm: 'off',
  consult: null,
  armLabel: 'off',
  trial: 0,
  sessionId: 'cccccccc-0003-0003-0003-000000000003',
  transcriptPath: null,
  journalPath: null,
  model: 'sonnet',
  exitCode: 0,
  wallMs: 20000,
  artifactPresent: true,
  diffChars: 300,
  diffTokens: 75,
  inputTokens: 1500,
  outputTokens: 900,
  cacheReadTokens: 0,
  totalTokens: 2400,
  solved: true,
  pass: 4,
  total: 4,
  edgePass: 1,
  edgeTotal: 1,
  gradeError: null,
  cases: [],
};

// Write the synthetic results file
const resultsContent = [onRow, offRow, offOnlyRow]
  .map((r) => JSON.stringify(r))
  .join('\n') + '\n';
fs.writeFileSync(RESULTS, resultsContent, 'utf8');

// ── Run the reducer ───────────────────────────────────────────────────────────
let stats;
try {
  stats = reduce(RESULTS, OUT);
} catch (e) {
  console.error('reduce() threw:', e);
  process.exit(1);
}

// ── Read back the output ──────────────────────────────────────────────────────
const outputRows = readJsonl(OUT);

// Find the paired row (overlay-save, trial 0) and the unpaired row (locale-sum)
const pairedRow = outputRows.find((r) => r.candidate === 'overlay-save' && r.trial === 0);
const unpairedRow = outputRows.find((r) => r.candidate === 'locale-sum' && r.trial === 0);

// ── Assertions ────────────────────────────────────────────────────────────────

// 1. Stats: 2 groups (overlay-save/0 and locale-sum/0), 1 paired, 1 unpaired
ok('stats.totalGroups === 2', stats.totalGroups === 2);
ok('stats.pairedCount === 1', stats.pairedCount === 1);
ok('stats.unpairedCount === 1', stats.unpairedCount === 1);

// 2. Paired row exists
ok('pairedRow is defined', pairedRow != null);

if (pairedRow) {
  // 3. paired flag
  ok('pairedRow.paired === true', pairedRow.paired === true);

  // 4. solved_delta: on=true(1), off=false(0) → delta = 1
  ok('pairedRow.solved_delta === 1', pairedRow.solved_delta === 1);

  // 5. cost_delta_output: on=800, off=1500 → delta = -700 (KB saved tokens)
  ok('pairedRow.cost_delta_output === -700', pairedRow.cost_delta_output === -700);

  // 6. on arm fields
  ok('pairedRow.on.solved === true', pairedRow.on && pairedRow.on.solved === true);
  ok('pairedRow.on.output_tokens === 800', pairedRow.on && pairedRow.on.output_tokens === 800);
  ok('pairedRow.on.total_tokens === 2800', pairedRow.on && pairedRow.on.total_tokens === 2800);

  // 7. off arm fields
  ok('pairedRow.off.solved === false', pairedRow.off && pairedRow.off.solved === false);
  ok('pairedRow.off.output_tokens === 1500', pairedRow.off && pairedRow.off.output_tokens === 1500);

  // 8. gate decision parsed from transcript
  ok('pairedRow.on.gate is not null', pairedRow.on && pairedRow.on.gate != null);
  if (pairedRow.on && pairedRow.on.gate) {
    ok('on.gate.decision === "inject"', pairedRow.on.gate.decision === 'inject');
    ok('on.gate.top1 === 0.62', pairedRow.on.gate.top1 === 0.62);
    ok('on.gate.margin === 0.15', pairedRow.on.gate.margin === 0.15);
    ok('on.gate.gap === 0.08', pairedRow.on.gate.gap === 0.08);
    ok('on.gate.locality === 2', pairedRow.on.gate.locality === 2);
    ok('on.gate.topType === "empirical"', pairedRow.on.gate.topType === 'empirical');
    ok('on.gate.via === "semantic"', pairedRow.on.gate.via === 'semantic');
  }

  // 9. consult/model metadata preserved
  ok('pairedRow.consult === "gated"', pairedRow.consult === 'gated');
  ok('pairedRow.model === "sonnet"', pairedRow.model === 'sonnet');
}

// 10. Single-arm (unpaired) case
ok('unpairedRow is defined', unpairedRow != null);
if (unpairedRow) {
  ok('unpairedRow.paired === false', unpairedRow.paired === false);
  ok('unpairedRow.missing === "on"', unpairedRow.missing === 'on');
}

// 11. Non-gated on-arm → gate should be null
// Create a second test with a non-gated on-arm
const RESULTS2 = path.join(TMP, 'results2.jsonl');
const OUT2 = path.join(TMP, 'journal2.jsonl');
const nonGatedOnRow = { ...onRow, consult: 'search', armLabel: 'on-search' };
fs.writeFileSync(RESULTS2, [nonGatedOnRow, offRow].map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
const stats2 = reduce(RESULTS2, OUT2);
const rows2 = readJsonl(OUT2);
const paired2 = rows2.find((r) => r.candidate === 'overlay-save');
ok('non-gated: gate is null when consult !== gated', paired2 && paired2.on && paired2.on.gate === null);
ok('non-gated: paired:true still', paired2 && paired2.paired === true);

// 12. Idempotency: running reduce() a second time produces identical output
reduce(RESULTS, OUT);
const outputRows2 = readJsonl(OUT);
ok('idempotent: same number of rows after second run', outputRows.length === outputRows2.length);
const pairedRow2 = outputRows2.find((r) => r.candidate === 'overlay-save' && r.trial === 0);
ok('idempotent: solved_delta unchanged', pairedRow2 && pairedRow2.solved_delta === 1);

// 13. parseGateDecision: missing transcript → null
ok('parseGateDecision: null path → null', parseGateDecision(null) === null);
ok('parseGateDecision: nonexistent path → null', parseGateDecision('/tmp/does-not-exist-xyz.jsonl') === null);

// 14. readJsonl: missing file → empty array
ok('readJsonl: nonexistent file → []', readJsonl('/tmp/no-such-file-xyz.jsonl').length === 0);

// ── Cleanup ───────────────────────────────────────────────────────────────────
try { fs.rmSync(TMP, { recursive: true, force: true }); } catch { /* ignore */ }

// ── Summary ───────────────────────────────────────────────────────────────────
console.log('');
console.log(`=== bench-learning-journal.test.js: ${pass} passed, ${fail} failed ===`);
if (fail > 0) process.exit(1);
