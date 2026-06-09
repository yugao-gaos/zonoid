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
// Exploration corroborators (v4): local tool_use blocks signalling real exploration/edit work.
const EXPLORE_TOOLS = new Set(['Read', 'Grep', 'Glob', 'Bash', 'Edit', 'Write']);
const PM = '±';     // plus-minus
const MULT = '×';   // multiplication sign
const MDASH = '—';  // em dash

// Cost weights: approximate Anthropic input-token-EQUIVALENT price ratios, normalized so plain
// input = 1.0. These are APPROXIMATE and model-dependent (e.g. on a model where input is $3/Mtok
// and output is $15/Mtok, output is 5x input; 5m-cache writes are ~1.25x input; cache reads ~0.1x).
// Raw token sums (GROSS/NET) treat every token equally and so OVERSTATE cost, because cache_read
// tokens — re-attended context — bill at ~10% of fresh input. cost_tok_eq reweights to reflect that.
const INPUT_W = 1.0;          // fresh (uncached) input tokens
const OUTPUT_W = 5.0;         // output tokens (~5x input on Sonnet/Opus-class pricing)
const CACHE_READ_W = 0.1;     // cache-hit input tokens bill at ~10% of fresh input
const CACHE_CREATION_W = 1.25; // writing the 5-minute cache costs ~1.25x fresh input

// Cost in input-token-equivalents for one usage bucket {input,output,cacheRead,cacheCreate}.
const costTokEq = (b) =>
  b.input * INPUT_W + b.output * OUTPUT_W + b.cacheRead * CACHE_READ_W + b.cacheCreate * CACHE_CREATION_W;

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
    let explorers = 0; // count of exploration-corroborator tool_use blocks (see EXPLORE_TOOLS)
    for (const line of fs.readFileSync(p, 'utf8').split('\n')) {
      if (!line.trim()) continue;
      let o; try { o = JSON.parse(line); } catch { continue; }
      // (a) usage split
      const u = (o.message && o.message.usage) || o.usage;
      if (u) {
        add(gross, u);
        if (o.attributionMcpServer === ORCH) add(plumbing, u);
      }
      // (b) exploration corroborators: tool_use blocks naming a local exploration/edit tool.
      const content = o.message && o.message.content;
      if (Array.isArray(content)) {
        for (const blk of content) {
          if (blk && blk.type === 'tool_use' && EXPLORE_TOOLS.has(blk.name)) explorers++;
        }
      }
    }
    const net = bucket();
    for (const k of ['input', 'output', 'cacheRead', 'cacheCreate', 'messages']) net[k] = gross[k] - plumbing[k];
    net.total = net.input + net.output + net.cacheRead + net.cacheCreate;
    return { gross, plumbing, net, explorers };
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
      explorers: split.explorers || 0,
      diffTokens: typeof r.diffTokens === 'number' ? r.diffTokens : 0, // W proxy (real-work size)
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
    const cg = c.runs.map((r) => costTokEq(r.gross));   // cost-weighted gross
    const cn = c.runs.map((r) => costTokEq(r.net));     // cost-weighted net
    const walls = c.runs.map((r) => r.wallMs).filter((w) => w !== null);
    // v4 decomposition (per design note-mq72538c):
    //   W = diffTokens (real-work proxy); total_output = transcript output tokens;
    //   H = max(0, total_output - W) (hardness, output beyond the final artifact);
    //   explorers = count of local exploration/edit tool_use blocks.
    const ws = c.runs.map((r) => r.diffTokens);
    const outs = c.runs.map((r) => r.gross.output);
    const hs = c.runs.map((r) => Math.max(0, r.gross.output - r.diffTokens));
    const exs = c.runs.map((r) => r.explorers);
    return {
      problem: c.problem, arm: c.arm, n: c.runs.length,
      gross: stats(g), net: stats(nt), plumbing: stats(pl),
      costGross: stats(cg), costNet: stats(cn),
      wallMs: walls.length ? stats(walls) : null,
      W: stats(ws), totalOutput: stats(outs), H: stats(hs), explorers: stats(exs),
      // cache cost (tok-eq) of carrying context: cache_read*0.1 + cache_creation*1.25, per run.
      cacheCost: stats(c.runs.map((r) => r.gross.cacheRead * CACHE_READ_W + r.gross.cacheCreate * CACHE_CREATION_W)),
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
      costGrossOnOverOff: on && off ? ratio(on.costGross, off.costGross) : null,
      costNetOnOverOff: on && off ? ratio(on.costNet, off.costNet) : null,
      haveBoth: !!(on && off),
    };
  }).sort((a, b) => a.problem.localeCompare(b.problem));

  // --- v4 decomposition: per-problem Real-Work / Hardness / Consult-overhead + win evaluation. ---
  // (design note-mq72538c). Solve rate uses ALL runs (incl. dropped), not just the solved aggregates.
  const solveTally = {}; // problem -> arm -> {solved,total}
  for (const run of runs) {
    const arm = String(run.arm).toUpperCase();
    const t = (solveTally[run.problem] || (solveTally[run.problem] = {}));
    const a = (t[arm] || (t[arm] = { solved: 0, total: 0 }));
    a.total++; if (run.solved) a.solved++;
  }
  // pooled (n-1) stdev of two sample arrays (returns 0 if combined n<2).
  const pooledStdev = (xa, xb) => {
    const n = xa.length + xb.length;
    if (n < 2) return 0;
    const all = xa.concat(xb);
    const m = all.reduce((s, v) => s + v, 0) / n;
    return Math.sqrt(all.reduce((s, v) => s + (v - m) ** 2, 0) / (n - 1));
  };
  const v4 = Object.entries(byProblem).map(([problem, arms]) => {
    const on = arms.ON, off = arms.OFF;
    if (!on || !off) {
      return { problem, haveBoth: false, win: false };
    }
    const W_on = on.W.mean, W_off = off.W.mean;
    const H_on = on.H.mean, H_off = off.H.mean;
    // C: extra cache cost (tok-eq) ON carries to hold graph context.
    const C = on.cacheCost.mean - off.cacheCost.mean;
    // METRIC: cost-weighted hardness savings (output weight x5) minus consult overhead.
    const metric = (H_off - H_on) * OUTPUT_W - C;

    // per-run cost-weighted H arrays for pooled stdev (H is output tokens -> weight x5).
    const onCell = cells[`${problem} ${on.arm}`], offCell = cells[`${problem} ${off.arm}`];
    const hOnW = onCell.runs.map((r) => Math.max(0, r.gross.output - r.diffTokens) * OUTPUT_W);
    const hOffW = offCell.runs.map((r) => Math.max(0, r.gross.output - r.diffTokens) * OUTPUT_W);
    const pStdev = pooledStdev(hOnW, hOffW);
    const nPooled = hOnW.length + hOffW.length;

    const tally = solveTally[problem] || {};
    const solveRate = (a) => (tally[a] && tally[a].total ? tally[a].solved / tally[a].total : 0);
    const solveOn = solveRate('ON'), solveOff = solveRate('OFF');

    // four win guards
    const gPrecondition = H_off >= 2 * W_off;
    const gFairness = solveOn >= 0.8 && solveOff >= 0.8;
    const gMargin = metric > 0 && metric > pStdev; // gap > 1 pooled stdev
    const corrobRatio = W_off !== 0 ? W_on / W_off : (W_on === 0 ? 1 : Infinity);
    const gCorroboration = corrobRatio <= 1.1;
    const win = gPrecondition && gFairness && gMargin && gCorroboration;

    return {
      problem, haveBoth: true,
      W_on, W_off, H_on, H_off, C, metric,
      pooledStdev: pStdev, nPooled,
      solveOn, solveOff, corrobRatio,
      guards: {
        precondition: gPrecondition, fairness: gFairness, margin: gMargin, corroboration: gCorroboration,
      },
      win,
    };
  }).sort((a, b) => a.problem.localeCompare(b.problem));

  return { rows, ratios, v4, contaminated, dropped, unreadable, runs };
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
  L.push(`## Per problem ${MULT} arm ${MDASH} Raw tokens`);
  L.push('');
  L.push('Every token counted equally (cache reads at face value). This OVERSTATES dollar cost.');
  L.push('');
  L.push('| problem | arm | n | gross (tok) | net (tok) | plumbing (tok) | wall (ms) |');
  L.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const r of model.rows) {
    L.push(`| ${r.problem} | ${r.arm} | ${r.n} | ${cell(r.gross)} | ${cell(r.net)} | ${cell(r.plumbing)} | ${r.wallMs ? cell(r.wallMs) : 'n/a'} |`);
  }
  L.push('');
  L.push(`## Per problem ${MULT} arm ${MDASH} Cost-weighted (tok-equivalents)`);
  L.push('');
  L.push(`Input-token-equivalents: input${MULT}${INPUT_W}, output${MULT}${OUTPUT_W}, cache_read${MULT}${CACHE_READ_W}, cache_creation${MULT}${CACHE_CREATION_W}. `
    + 'Weights are **approximate** and model-dependent.');
  L.push('');
  L.push('| problem | arm | n | cost gross (tok-eq) | cost net (tok-eq) |');
  L.push('| --- | --- | ---: | ---: | ---: |');
  for (const r of model.rows) {
    L.push(`| ${r.problem} | ${r.arm} | ${r.n} | ${cell(r.costGross)} | ${cell(r.costNet)} |`);
  }
  L.push('');
  L.push('## Headline ratios (ON vs OFF, per problem)');
  L.push('');
  L.push(`Ratio of arm-ON mean over arm-OFF mean. <1.0${MULT} means the orchestrator arm used fewer tokens.`);
  L.push('');
  L.push('Raw columns weight every token equally; cost-weighted columns use the tok-equivalent weights above');
  L.push('(input/output/cache_read/cache_creation) and are **approximate**.');
  L.push('');
  L.push('| problem | net ON/OFF (raw) | gross ON/OFF (raw) | cost net ON/OFF | cost gross ON/OFF |');
  L.push('| --- | ---: | ---: | ---: | ---: |');
  for (const r of model.ratios) {
    L.push(`| ${r.problem} | ${fmtRatio(r.netOnOverOff)} | ${fmtRatio(r.grossOnOverOff)} | ${fmtRatio(r.costNetOnOverOff)} | ${fmtRatio(r.costGrossOnOverOff)} |`);
  }
  L.push('');

  // --- v4 decomposition section (design note-mq72538c) ---
  const fmtN = (n) => (n === null || n === undefined ? 'n/a' : fmtTok(n));
  const fmt3 = (n) => (n === null || n === undefined ? 'n/a' : Number(n).toFixed(3));
  const PF = (b) => (b ? 'PASS' : 'FAIL');
  L.push('## v4 decomposition (W / H / C)');
  L.push('');
  L.push('Decomposes spend into **Real-Work** `W` (= `diffTokens`, the final solution size), **Hardness**');
  L.push(`\`H = max(0, total_output ${MDASH} W)\` (output beyond the artifact), and **Consult-overhead** \`C\``);
  L.push('(extra cache cost the ON arm carries to hold graph context). Means are over solved trials.');
  L.push('');
  L.push('| problem | arm | n | W (tok) | total_output (tok) | H (tok) | explorers |');
  L.push('| --- | --- | ---: | ---: | ---: | ---: | ---: |');
  for (const r of model.rows) {
    L.push(`| ${r.problem} | ${r.arm} | ${r.n} | ${cell(r.W)} | ${cell(r.totalOutput)} | ${cell(r.H)} | ${cell(r.explorers)} |`);
  }
  L.push('');
  L.push(`\`C = costCache(ON) ${MDASH} costCache(OFF)\` where \`costCache = cache_read${MULT}${CACHE_READ_W} + cache_creation${MULT}${CACHE_CREATION_W}\`. `
    + `\`METRIC = (H_off ${MDASH} H_on)${MULT}${OUTPUT_W} ${MDASH} C\` (hardness savings cost-weighted by the output weight, minus consult overhead).`);
  L.push('');
  L.push('| problem | C (tok-eq) | METRIC (tok-eq) | pooled stdev (n) |');
  L.push('| --- | ---: | ---: | ---: |');
  for (const v of model.v4) {
    if (!v.haveBoth) { L.push(`| ${v.problem} | n/a (missing arm) | n/a | n/a |`); continue; }
    L.push(`| ${v.problem} | ${fmtN(v.C)} | ${fmtN(v.metric)} | ${fmtN(v.pooledStdev)} (n=${v.nPooled}) |`);
  }
  L.push('');
  L.push('**Win evaluation** (all four guards must PASS for a WIN):');
  L.push('');
  L.push(`- precondition: \`H_off >= 2${MULT}W_off\` (hardness must dominate raw work)`);
  L.push('- fairness: both-arm solve-rate >= 0.8');
  L.push('- margin: `METRIC > 0` AND gap > 1 pooled stdev');
  L.push('- corroboration: `W_on / W_off <= 1.1` (ON not just writing less code)');
  L.push('');
  L.push('| problem | precondition | fairness | margin | corroboration | WIN |');
  L.push('| --- | --- | --- | --- | --- | --- |');
  for (const v of model.v4) {
    if (!v.haveBoth) { L.push(`| ${v.problem} | ${MDASH} | ${MDASH} | ${MDASH} | ${MDASH} | NO-WIN (missing arm) |`); continue; }
    const g = v.guards;
    L.push(`| ${v.problem} | ${PF(g.precondition)} | ${PF(g.fairness)} | ${PF(g.margin)} | ${PF(g.corroboration)} | ${v.win ? 'WIN' : 'NO-WIN'} |`);
  }
  L.push('');
  L.push('Guard inputs per problem:');
  L.push('');
  for (const v of model.v4) {
    if (!v.haveBoth) continue;
    L.push(`- **${v.problem}**: W_on=${fmtN(v.W_on)} W_off=${fmtN(v.W_off)} (ratio ${fmt3(v.corrobRatio)}); `
      + `H_on=${fmtN(v.H_on)} H_off=${fmtN(v.H_off)} (2${MULT}W_off=${fmtN(2 * v.W_off)}); `
      + `solve ON=${fmt3(v.solveOn)} OFF=${fmt3(v.solveOff)}; C=${fmtN(v.C)}; METRIC=${fmtN(v.metric)}.`);
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
  fs.writeFileSync(jsonPath, JSON.stringify({ meta, rows: model.rows, ratios: model.ratios, v4: model.v4, contaminated: model.contaminated, dropped: model.dropped, unreadable: model.unreadable, runs: model.runs }, null, 2));

  process.stderr.write(`bench-report: ${results.length} runs -> ${mdPath}, ${jsonPath}\n`);
  if (model.contaminated.length) process.stderr.write(`bench-report: WARNING ${model.contaminated.length} contaminated OFF-arm run(s)\n`);
}

module.exports = {
  readSplit, stats, parseResults, buildReport, renderMarkdown,
  costTokEq, INPUT_W, OUTPUT_W, CACHE_READ_W, CACHE_CREATION_W,
};

if (require.main === module) main();
