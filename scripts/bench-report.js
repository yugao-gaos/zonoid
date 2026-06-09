#!/usr/bin/env node
// bench-report - aggregate headless-bench runs into bench/report.{md,json}.
//
// INPUT: runner result lines, each { problem, arm, trial, sessionId, transcriptPath, solved, wallMs? }.
//   Pass a path to a JSON array OR a JSONL file of these, or pipe them on stdin (JSON array or JSONL).
//
// Per transcript we read message.usage (same shape/keys as daemon.js readUsage) and compute:
//   GROSS    = sum of ALL message.usage in the file (input/output/cache reported separately + a total).
//   PLUMBING = sum of usage on messages tagged top-level attributionMcpServer === 'orchestrator-graph'.
//   NET      = GROSS - PLUMBING.
// For arm 'OFF' plumbing must be ~0; any orchestrator-graph attribution on an OFF run is FLAGGED as
// contaminated. Runs with solved===false are dropped from aggregates (but reported as dropped).
//
// KNOWN LIMITATION: MCP tool *schema* tokens loaded into context (cache_creation/cache_read) are
// amortized across the session and not attributable per-message, so PLUMBING captures tool_use /
// tool_result round-trips but UNDER-COUNTS the always-resident schema overhead. See report.md note.
'use strict';
const fs = require('fs');
const path = require('path');

const ORCH = 'orchestrator-graph';
const PM = '±';     // plus-minus
const MULT = '×';   // multiplication sign
const MDASH = '—';  // em dash

// Sum per-message usage across a transcript, splitting GROSS vs PLUMBING (orchestrator-graph-attributed).
// Mirrors daemon.js readUsage() for the gross side; adds the attribution split. Returns {gross,plumbing,net}
// where each bucket is {input,output,cacheRead,cacheCreate,total,messages}. `error` set if unreadable.
function readSplit(p) {
  const bucket = () => ({ input: 0, output: 0, cacheRead: 0, cacheCreate: 0, total: 0, messages: 0 });
  const add = (b, u) => {
    b.messages++;
    b.input += u.input_tokens || 0;
    b.output += u.output_tokens || 0;
    b.cacheRead += u.cache_read_input_tokens || 0;
    b.cacheCreate += u.cache_creation_input_tokens || 0;
    b.total = b.input + b.output + b.cacheRead + b.cacheCreate;
  };
  try {
    const gross = bucket(), plumbing = bucket();
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      const u = (o.message && o.message.usage) || o.usage;
      if (!u) continue;
      add(gross, u);
      if (o.attributionMcpServer === ORCH) add(plumbing, u);
    }
    const net = bucket();
    for (const k of ['input', 'output', 'cacheRead', 'cacheCreate', 'messages']) net[k] = gross[k] - plumbing[k];
    net.total = net.input + net.output + net.cacheRead + net.cacheCreate;
    return { gross, plumbing, net };
  } catch (e) { return { error: e.code || e.message }; }
}

// Sample mean + sample (n-1) stdev of a numeric array. stdev is 0 for n<2 (undefined sample stdev -> 0).
function stats(xs) {
  const n = xs.length;
  if (n === 0) return { mean: 0, stdev: 0, n: 0 };
  const mean = xs.reduce((a, b) => a + b, 0) / n;
  if (n < 2) return { mean, stdev: 0, n };
  const variance = xs.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1);
  return { mean, stdev: Math.sqrt(variance), n };
}

// Parse the input blob as a JSON array first, else as JSONL (one result object per line).
function parseResults(raw) {
  const t = raw.trim();
  if (!t) return [];
  try { const j = JSON.parse(t); if (Array.isArray(j)) return j; } catch { /* fall through to JSONL */ }
  const out = [];
  for (const line of t.split('\n')) {
    const s = line.trim(); if (!s) continue;
    try { out.push(JSON.parse(s)); } catch { /* skip junk */ }
  }
  return out;
}

// Build the full report model from runner result lines.
function buildReport(results) {
  const runs = [];
  const contaminated = [];
  const dropped = [];
  const unreadable = [];

  for (const r of results) {
    const split = readSplit(r.transcriptPath);
    if (split.error) {
      unreadable.push({ problem: r.problem, arm: r.arm, trial: r.trial, transcriptPath: r.transcriptPath, error: split.error });
      continue;
    }
    const run = {
      problem: r.problem, arm: r.arm, trial: r.trial, sessionId: r.sessionId,
      transcriptPath: r.transcriptPath, solved: r.solved !== false,
      wallMs: typeof r.wallMs === 'number' ? r.wallMs : null,
      gross: split.gross, plumbing: split.plumbing, net: split.net,
    };
    const isOff = String(r.arm).toUpperCase() === 'OFF';
    if (isOff && split.plumbing.total > 0) {
      run.contaminated = true;
      contaminated.push({ problem: r.problem, arm: r.arm, trial: r.trial, plumbingTotal: split.plumbing.total, messages: split.plumbing.messages });
    }
    if (!run.solved) dropped.push({ problem: r.problem, arm: r.arm, trial: r.trial, reason: 'solved===false' });
    runs.push(run);
  }

  const cells = {};
  for (const run of runs) {
    if (!run.solved) continue;
    const key = `${run.problem} ${run.arm}`;
    (cells[key] || (cells[key] = { problem: run.problem, arm: run.arm, runs: [] })).runs.push(run);
  }
  const rows = Object.values(cells).map((c) => {
    const g = c.runs.map((r) => r.gross.total);
    const nt = c.runs.map((r) => r.net.total);
    const pl = c.runs.map((r) => r.plumbing.total);
    const walls = c.runs.map((r) => r.wallMs).filter((w) => w !== null);
    return {
      problem: c.problem, arm: c.arm, n: c.runs.length,
      gross: stats(g), net: stats(nt), plumbing: stats(pl),
      wallMs: walls.length ? stats(walls) : null,
    };
  }).sort((a, b) => a.problem.localeCompare(b.problem) || a.arm.localeCompare(b.arm));

  const byProblem = {};
  for (const row of rows) (byProblem[row.problem] || (byProblem[row.problem] = {}))[String(row.arm).toUpperCase()] = row;
  const ratios = Object.entries(byProblem).map(([problem, arms]) => {
    const on = arms.ON, off = arms.OFF;
    const ratio = (a, b) => (a && b && b.mean !== 0 ? a.mean / b.mean : null);
    return {
      problem,
      netOnOverOff: on && off ? ratio(on.net, off.net) : null,
      grossOnOverOff: on && off ? ratio(on.gross, off.gross) : null,
      haveBoth: !!(on && off),
    };
  }).sort((a, b) => a.problem.localeCompare(b.problem));

  return { rows, ratios, contaminated, dropped, unreadable, runs };
}

// --- rendering ---
const fmtTok = (n) => Math.round(n).toLocaleString('en-US');
const cell = (s) => `${fmtTok(s.mean)} ${PM} ${fmtTok(s.stdev)}`;
const fmtRatio = (r) => (r === null ? 'n/a' : `${r.toFixed(3)}${MULT}`);

function renderMarkdown(model, meta) {
  const L = [];
  L.push('# Headless bench report');
  L.push('');
  L.push(`Generated ${new Date().toISOString()} from \`${meta.source}\` (${meta.resultCount} result lines).`);
  L.push('');
  L.push(`Token figures are **mean ${PM} sample stdev** over solved trials. GROSS = all \`message.usage\` in the`);
  L.push(`transcript; PLUMBING = usage on messages tagged \`attributionMcpServer:"orchestrator-graph"\`; NET = GROSS - PLUMBING.`);
  L.push('');
  L.push(`## Per problem ${MULT} arm`);
  L.push('');
  L.push('| problem | arm | n | gross (tok) | net (tok) | plumbing (tok) | wall (ms) |');
  L.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const r of model.rows) {
    L.push(`| ${r.problem} | ${r.arm} | ${r.n} | ${cell(r.gross)} | ${cell(r.net)} | ${cell(r.plumbing)} | ${r.wallMs ? cell(r.wallMs) : 'n/a'} |`);
  }
  L.push('');
  L.push('## Headline ratios (ON vs OFF, per problem)');
  L.push('');
  L.push(`Ratio of arm-ON mean over arm-OFF mean. <1.0${MULT} means the orchestrator arm used fewer tokens.`);
  L.push('');
  L.push('| problem | net ON/OFF | gross ON/OFF |');
  L.push('| --- | ---: | ---: |');
  for (const r of model.ratios) {
    L.push(`| ${r.problem} | ${fmtRatio(r.netOnOverOff)} | ${fmtRatio(r.grossOnOverOff)} |`);
  }
  L.push('');
  L.push('## Contamination & drop notes');
  L.push('');
  if (model.contaminated.length) {
    L.push(`**CONTAMINATED ${MDASH} OFF-arm runs carrying \`orchestrator-graph\` attribution (should be ~0):**`);
    L.push('');
    for (const c of model.contaminated) L.push(`- ${c.problem} / ${c.arm} / trial ${c.trial}: ${fmtTok(c.plumbingTotal)} plumbing tok over ${c.messages} msg(s)`);
    L.push('');
  } else {
    L.push('No contamination: every OFF-arm run had zero `orchestrator-graph` attribution.');
    L.push('');
  }
  if (model.dropped.length) {
    L.push('**Dropped from aggregates (solved===false):**');
    L.push('');
    for (const d of model.dropped) L.push(`- ${d.problem} / ${d.arm} / trial ${d.trial} (${d.reason})`);
    L.push('');
  } else {
    L.push('No runs dropped: all input runs were solved.');
    L.push('');
  }
  if (model.unreadable.length) {
    L.push('**Unreadable transcripts (excluded entirely):**');
    L.push('');
    for (const u of model.unreadable) L.push(`- ${u.problem} / ${u.arm} / trial ${u.trial}: ${u.transcriptPath} (${u.error})`);
    L.push('');
  }
  L.push('## Known limitation');
  L.push('');
  L.push('MCP tool **schema** tokens loaded into context (counted under `cache_creation_input_tokens` /');
  L.push('`cache_read_input_tokens` when the system prompt + tool list are cached) are amortized across the');
  L.push('whole session and are **not attributable to individual messages**. PLUMBING therefore captures the');
  L.push('orchestrator `tool_use` / `tool_result` round-trips but **under-counts the always-resident schema');
  L.push('overhead** of having the orchestrator-graph MCP server loaded. Treat NET as an upper bound on the');
  L.push('"work-only" token cost and PLUMBING as a lower bound on the true orchestration overhead.');
  L.push('');
  return L.join('\n');
}

function main() {
  const arg = process.argv[2];
  let raw, source;
  if (arg) { raw = fs.readFileSync(arg, 'utf8'); source = arg; }
  else { raw = fs.readFileSync(0, 'utf8'); source = '<stdin>'; }

  const results = parseResults(raw);
  const model = buildReport(results);
  const meta = { source, resultCount: results.length, generatedAt: new Date().toISOString() };

  const repoRoot = path.resolve(__dirname, '..');
  const outDir = path.join(repoRoot, 'bench');
  fs.mkdirSync(outDir, { recursive: true });
  const mdPath = path.join(outDir, 'report.md');
  const jsonPath = path.join(outDir, 'report.json');

  fs.writeFileSync(mdPath, renderMarkdown(model, meta));
  fs.writeFileSync(jsonPath, JSON.stringify({ meta, rows: model.rows, ratios: model.ratios, contaminated: model.contaminated, dropped: model.dropped, unreadable: model.unreadable, runs: model.runs }, null, 2));

  process.stderr.write(`bench-report: ${results.length} runs -> ${mdPath}, ${jsonPath}\n`);
  if (model.contaminated.length) process.stderr.write(`bench-report: WARNING ${model.contaminated.length} contaminated OFF-arm run(s)\n`);
}

module.exports = { readSplit, stats, parseResults, buildReport, renderMarkdown };

if (require.main === module) main();
