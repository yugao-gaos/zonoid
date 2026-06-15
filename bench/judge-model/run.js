#!/usr/bin/env node
// bench/judge-model/run.js
//
// Compares haiku vs sonnet for edge keep/prune verdict quality on the labeled eval set.
// Ground truth: bench/judge-edge/eval-set.json (27 entries, should_wire true/false)
//
// Usage: node bench/judge-model/run.js
'use strict';

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '../..');
const CLAUDE = '/opt/homebrew/bin/claude';

// Models to compare
const MODELS = {
  haiku: 'claude-haiku-4-5-20251001',
  sonnet: 'claude-sonnet-4-6',
};

// Cost weights (input-token-equivalents, matching bench-economy.js)
// weighted = input*1.0 + output*5.0 + cache_read*0.1 + cache_creation*1.25
const INPUT_W = 1.0;
const OUTPUT_W = 5.0;
const CACHE_READ_W = 0.1;
const CACHE_CREATION_W = 1.25;

// Cosine bands for accuracy breakdown
const BANDS = [
  { label: '[0.25-0.40)', lo: 0.25, hi: 0.40 },
  { label: '[0.40-0.60)', lo: 0.40, hi: 0.60 },
  { label: '[0.60-0.80)', lo: 0.60, hi: 0.80 },
  { label: '[0.80-1.00]', lo: 0.80, hi: 1.01 },
];

function bandFor(cosine) {
  for (const b of BANDS) {
    if (cosine >= b.lo && cosine < b.hi) return b.label;
  }
  return 'other';
}

// Build the judge prompt for a single eval entry.
// Mirrors what the real judge agent sees: the edge endpoints, cosine, and content.
function buildPrompt(entry) {
  const noteTitle = entry.note_title || '(unknown note)';
  const noteSummary = entry.note_summary || '';
  const taskTitle = entry.task_title || '(unknown task)';
  const cosine = typeof entry.cosine === 'number' ? entry.cosine.toFixed(3) : '?';

  return `You are adjudicating a knowledge-graph context edge. A context edge (from NOTE to TASK) means the note provides a genuine prerequisite for understanding or executing the task. Decide KEEP or PRUNE.

EDGE:
  from (note): ${noteTitle}
  note summary: ${noteSummary.slice(0, 300)}
  to (task): ${taskTitle}
  cosine similarity: ${cosine}

CRITERIA (conservative - default is PRUNE):
- KEEP only if the note's fact is a genuine prerequisite that a worker on this task would NEED to understand or act correctly. Topical nearness alone is not enough.
- PRUNE if the two nodes are merely topically near but neither fact is needed to understand or act on the other.

Reply with exactly KEEP or PRUNE on the first line, then one sentence of reasoning.`;
}

// Parse verdict (KEEP/PRUNE) from model response text. First occurrence wins.
function parseVerdict(text) {
  if (!text) return null;
  const m = text.match(/\b(KEEP|PRUNE)\b/i);
  return m ? m[1].toUpperCase() : null;
}

// Extract token usage from stream-json stdout lines.
function extractUsageFromStdout(stdout) {
  const usage = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 };
  if (!stdout) return usage;
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const u = (obj.message && obj.message.usage) || obj.usage;
    if (u) {
      usage.input_tokens += u.input_tokens || 0;
      usage.output_tokens += u.output_tokens || 0;
      usage.cache_read_input_tokens += u.cache_read_input_tokens || 0;
      usage.cache_creation_input_tokens += u.cache_creation_input_tokens || 0;
    }
  }
  return usage;
}

// Extract the assistant's text from stream-json stdout.
function extractResponseText(stdout) {
  if (!stdout) return '';
  const parts = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (obj.type === 'content_block_delta' && obj.delta && obj.delta.type === 'text_delta') {
      parts.push(obj.delta.text || '');
    }
    if (obj.type === 'result' && typeof obj.result === 'string') {
      parts.push(obj.result);
    }
  }
  return parts.join('');
}

// Compute weighted cost from usage object.
function weightedCost(usage) {
  return (
    (usage.input_tokens || 0) * INPUT_W +
    (usage.output_tokens || 0) * OUTPUT_W +
    (usage.cache_read_input_tokens || 0) * CACHE_READ_W +
    (usage.cache_creation_input_tokens || 0) * CACHE_CREATION_W
  );
}

// Run a single eval case for a given model.
function runCase(entry, modelId) {
  const prompt = buildPrompt(entry);
  const args = [
    '-p', prompt,
    '--model', modelId,
    '--output-format', 'stream-json',
    '--verbose',
    '--dangerously-skip-permissions',
  ];

  const result = spawnSync(CLAUDE, args, {
    encoding: 'utf8',
    maxBuffer: 16 * 1024 * 1024,
    timeout: 90000,
    env: { ...process.env },
  });

  if (result.error) {
    return { verdict: null, usage: null, responseText: '', error: result.error.message };
  }

  const stdout = result.stdout || '';
  const usage = extractUsageFromStdout(stdout);
  const responseText = extractResponseText(stdout);
  const verdict = parseVerdict(responseText) || parseVerdict(result.stderr || '');

  return {
    verdict,
    usage,
    responseText: responseText.slice(0, 500),
    error: result.status !== 0 && !responseText ? 'exit ' + result.status : null,
  };
}

// Compute precision/recall/F1. Ground truth: should_wire=true means KEEP.
function computeMetrics(results) {
  let tp = 0, fp = 0, fn = 0, tn = 0;
  for (const r of results) {
    if (r.verdict === null) continue; // skip nulls from metrics
    const pred = r.verdict === 'KEEP';
    const label = r.groundTruth;
    if (pred && label) tp++;
    else if (pred && !label) fp++;
    else if (!pred && label) fn++;
    else tn++;
  }
  const precision = tp + fp === 0 ? 0 : tp / (tp + fp);
  const recall = tp + fn === 0 ? 0 : tp / (tp + fn);
  const f1 = precision + recall === 0 ? 0 : 2 * precision * recall / (precision + recall);
  const scored = tp + fp + fn + tn;
  const accuracy = scored === 0 ? 0 : (tp + tn) / scored;
  return { tp, fp, fn, tn, precision, recall, f1, accuracy, n: results.length, scored };
}

// Compute accuracy breakdown by cosine band.
function computeBandBreakdown(results) {
  const byBand = {};
  for (const b of BANDS) byBand[b.label] = [];
  for (const r of results) {
    const band = bandFor(r.cosine);
    if (byBand[band]) byBand[band].push(r);
  }
  const out = {};
  for (const b of BANDS) {
    const items = byBand[b.label];
    if (items.length === 0) { out[b.label] = { n: 0 }; continue; }
    out[b.label] = { n: items.length, ...computeMetrics(items) };
  }
  return out;
}

function fmt(v, digits) {
  return v != null ? (v * 100).toFixed(digits || 1) + '%' : 'n/a';
}

function printSummary(modelResults) {
  console.log('\n' + '='.repeat(72));
  console.log('JUDGE MODEL BENCH: haiku vs sonnet verdict quality + cost');
  console.log('='.repeat(72));
  console.log('\nPrior informal finding: haiku rubber-stamped ~100% as KEEP (0% prune rate);');
  console.log('sonnet pruned ~45%. Verified here with labeled P/R/F1 on 27 eval cases.\n');

  for (const [name, data] of Object.entries(modelResults)) {
    const m = data.metrics;
    const totalCost = data.results.reduce((s, r) => s + (r.cost || 0), 0);
    const costPerVerdict = data.results.length > 0 ? totalCost / data.results.length : 0;
    const keepCount = data.results.filter((r) => r.verdict === 'KEEP').length;
    const pruneCount = data.results.filter((r) => r.verdict === 'PRUNE').length;
    const nullCount = data.results.filter((r) => !r.verdict).length;

    console.log('Model: ' + name + ' (' + MODELS[name] + ')');
    console.log('  N=' + m.n + '  scored=' + m.scored + '  TP=' + m.tp + ' FP=' + m.fp + ' FN=' + m.fn + ' TN=' + m.tn);
    console.log('  Precision: ' + fmt(m.precision) + '  Recall: ' + fmt(m.recall) + '  F1: ' + fmt(m.f1) + '  Accuracy: ' + fmt(m.accuracy));
    console.log('  KEEP=' + keepCount + ' PRUNE=' + pruneCount + ' NULL=' + nullCount +
      '  (keep rate ' + (keepCount / m.n * 100).toFixed(1) + '%, prune rate ' + (pruneCount / m.n * 100).toFixed(1) + '%)');
    console.log('  Total weighted tok-eq: ' + totalCost.toFixed(0) + '  Cost per verdict: ' + costPerVerdict.toFixed(1));

    console.log('\n  By cosine band:');
    for (const [band, bm] of Object.entries(data.bands)) {
      if (bm.n === 0) { console.log('    ' + band + ': n=0'); continue; }
      console.log('    ' + band + ': n=' + bm.n +
        '  acc=' + fmt(bm.accuracy) +
        '  P=' + fmt(bm.precision) +
        '  R=' + fmt(bm.recall) +
        '  F1=' + fmt(bm.f1));
    }
    console.log('');
  }
}

function main() {
  const evalPath = path.join(REPO, 'bench', 'judge-edge', 'eval-set.json');
  const outDir = path.join(REPO, 'bench', 'judge-model');
  const outPath = path.join(outDir, 'results.json');

  if (!fs.existsSync(evalPath)) {
    console.error('eval-set not found:', evalPath);
    process.exit(1);
  }

  const evalSet = JSON.parse(fs.readFileSync(evalPath, 'utf8'));
  console.log('Loaded ' + evalSet.length + ' eval entries');
  console.log('Total calls: ' + evalSet.length * Object.keys(MODELS).length + ' (' + evalSet.length + ' per model)');
  console.log('This will take ~5-10 minutes.\n');

  const allModelResults = {};

  for (const [modelName, modelId] of Object.entries(MODELS)) {
    console.log('\n--- Running ' + modelName + ' (' + modelId + ') ---');
    const results = [];

    for (let i = 0; i < evalSet.length; i++) {
      const entry = evalSet[i];
      const groundTruth = entry.should_wire;
      process.stdout.write('  [' + (i + 1) + '/' + evalSet.length + '] cos=' + entry.cosine + ' gt=' + (groundTruth ? 'KEEP' : 'PRUNE') + ' ... ');

      const { verdict, usage, responseText, error } = runCase(entry, modelId);
      const cost = usage ? weightedCost(usage) : 0;
      const correct = verdict !== null ? (verdict === 'KEEP') === groundTruth : null;

      if (error && !verdict) {
        process.stdout.write('ERROR: ' + error + '\n');
      } else {
        const mark = correct === true ? 'OK' : correct === false ? 'WRONG' : '?';
        process.stdout.write((verdict || 'NULL') + ' [' + mark + '] cost=' + cost.toFixed(0) + '\n');
      }

      results.push({
        idx: i,
        note_key: entry.note_key || null,
        task_key: entry.task_key || null,
        note_title: entry.note_title || null,
        task_title: entry.task_title || null,
        cosine: entry.cosine,
        groundTruth,
        verdict,
        correct,
        cost,
        usage: usage || null,
        error: error || null,
      });
    }

    const metrics = computeMetrics(results);
    const bands = computeBandBreakdown(results);
    allModelResults[modelName] = { modelId, results, metrics, bands };
  }

  fs.mkdirSync(outDir, { recursive: true });
  const output = {
    generated: new Date().toISOString(),
    evalSet: evalPath,
    n: evalSet.length,
    models: MODELS,
    costFormula: 'weighted = input*1.0 + output*5.0 + cache_read*0.1 + cache_creation*1.25',
    note: 'Prior informal finding: haiku rubber-stamped ~100% KEEP (0% prune); sonnet pruned ~45%.',
    results: allModelResults,
  };
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2));
  console.log('Results written to ' + outPath);

  printSummary(allModelResults);
}

main();
