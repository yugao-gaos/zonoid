#!/usr/bin/env node
// Plain Node test for scripts/bench-report.js (no framework; matches test/token-attr.test.js style).
// Run: node scripts/bench-report.test.js -- exits non-zero on any failed assertion.
//
// Builds tiny real transcript files on disk (so readSplit parses actual message.usage), then asserts
// the GROSS / NET / PLUMBING split, the aggregate stats, the ON/OFF ratios, and the OFF-arm
// contamination flag (an OFF run carrying attributionMcpServer:"orchestrator-graph" must be flagged).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { readSplit, stats, buildReport, costTokEq, INPUT_W, OUTPUT_W, CACHE_READ_W, CACHE_CREATION_W } = require('./bench-report.js');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };
const near = (a, b, eps = 1e-6) => Math.abs(a - b) < eps;

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-report-'));
const write = (name, lines) => { const p = path.join(tmp, name); fs.writeFileSync(p, lines.join('\n') + '\n'); return p; };

try {
  // --- (1) readSplit math on a 3-line fixture: 1 plain work msg, 1 orchestrator-graph msg, 1 work msg. ---
  // work A: in100 out20 -> total 120 ; orch: in10 out2 cacheRead5 -> total 17 ; work B: in30 out10 -> total 40
  // GROSS total = 120+17+40 = 177 ; PLUMBING total = 17 ; NET total = 160.
  const fxOn = write('on.jsonl', [
    JSON.stringify({ message: { usage: { input_tokens: 100, output_tokens: 20 } } }),
    JSON.stringify({ attributionMcpServer: 'orchestrator-graph', attributionMcpTool: 'start_task', message: { usage: { input_tokens: 10, output_tokens: 2, cache_read_input_tokens: 5 } } }),
    JSON.stringify({ message: { usage: { input_tokens: 30, output_tokens: 10 } } }),
  ]);
  const s = readSplit(fxOn);
  ok('readSplit no error', !s.error);
  ok('gross total = 177', s.gross.total === 177);
  ok('plumbing total = 17 (only orchestrator-graph msg)', s.plumbing.total === 17);
  ok('plumbing counted exactly 1 message', s.plumbing.messages === 1);
  ok('net total = gross - plumbing = 160', s.net.total === 160);
  ok('net = input/output/cache split correct', s.net.input === 130 && s.net.output === 30 && s.net.cacheRead === 0);
  ok('gross counted 3 messages', s.gross.messages === 3);

  // --- (1b) cost_tok_eq weighting on the same fixture. Weights: in=1, out=5, cacheRead=0.1, cacheCreate=1.25.
  // gross: in140 out32 cacheRead5 -> 140*1 + 32*5 + 5*0.1 = 140+160+0.5 = 300.5
  // plumbing (orch msg only): in10 out2 cacheRead5 -> 10 + 10 + 0.5 = 20.5 ; net = 300.5 - 20.5 = 280.
  ok('weights as documented', INPUT_W === 1.0 && OUTPUT_W === 5.0 && CACHE_READ_W === 0.1 && CACHE_CREATION_W === 1.25);
  ok('cost gross = 300.5', near(costTokEq(s.gross), 300.5));
  ok('cost plumbing = 20.5', near(costTokEq(s.plumbing), 20.5));
  ok('cost net = 280', near(costTokEq(s.net), 280));

  // --- (1c) cache_read-heavy line: raw total is dominated by cache reads, but cost weights them at 0.1x,
  // so the cost-weighted figure is MUCH lower than raw -- the whole point of the cost view.
  // in10 out10 cacheRead10000 -> raw total = 10020 ; cost = 10 + 50 + 10000*0.1 = 1060 (~9.5x cheaper).
  const fxHeavy = write('heavy.jsonl', [
    JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 10, cache_read_input_tokens: 10000 } } }),
  ]);
  const h = readSplit(fxHeavy);
  ok('cache-heavy raw total = 10020', h.gross.total === 10020);
  ok('cache-heavy cost = 1060 (cache reads weighted 0.1x)', near(costTokEq(h.gross), 1060));
  ok('cost visibly below raw for cache-heavy line', costTokEq(h.gross) < h.gross.total / 5);

  // --- (2) stats: mean + sample (n-1) stdev. [10,20,30] -> mean 20, var=((100+0+100)/2)=100, stdev 10. ---
  const st = stats([10, 20, 30]);
  ok('stats mean = 20', near(st.mean, 20));
  ok('stats sample stdev = 10', near(st.stdev, 10));
  ok('stats n = 3', st.n === 3);
  ok('stats stdev = 0 for n=1', stats([42]).stdev === 0 && stats([42]).mean === 42);

  // --- (3) OFF-arm contamination flag: an OFF run with an orchestrator-graph-tagged msg is flagged. ---
  const fxOffClean = write('off-clean.jsonl', [
    JSON.stringify({ message: { usage: { input_tokens: 90, output_tokens: 15 } } }),
  ]);
  const fxOffDirty = write('off-dirty.jsonl', [
    JSON.stringify({ message: { usage: { input_tokens: 90, output_tokens: 15 } } }),
    JSON.stringify({ attributionMcpServer: 'orchestrator-graph', message: { usage: { input_tokens: 8, output_tokens: 1 } } }),
  ]);
  const results = [
    { problem: 'greenfield', arm: 'ON',  trial: 1, transcriptPath: fxOn,       solved: true,  wallMs: 1000 },
    { problem: 'greenfield', arm: 'ON',  trial: 2, transcriptPath: fxOn,       solved: true,  wallMs: 1200 },
    { problem: 'greenfield', arm: 'OFF', trial: 1, transcriptPath: fxOffClean, solved: true,  wallMs: 800 },
    { problem: 'greenfield', arm: 'OFF', trial: 2, transcriptPath: fxOffDirty, solved: true,  wallMs: 900 },
  ];
  const model = buildReport(results);
  ok('one contaminated OFF run flagged', model.contaminated.length === 1);
  ok('contaminated entry is the dirty OFF run', model.contaminated[0] && model.contaminated[0].arm === 'OFF' && model.contaminated[0].plumbingTotal === 9);
  ok('clean OFF run NOT flagged', !model.contaminated.some((c) => c.trial === 1 && c.plumbingTotal === 0));

  // ON aggregate: two identical solved runs -> gross mean 177, net mean 160, plumbing mean 17.
  const onRow = model.rows.find((r) => r.arm === 'ON');
  ok('ON row n = 2', onRow && onRow.n === 2);
  ok('ON gross mean = 177', onRow && near(onRow.gross.mean, 177));
  ok('ON net mean = 160', onRow && near(onRow.net.mean, 160));
  ok('ON plumbing mean = 17', onRow && near(onRow.plumbing.mean, 17));
  ok('ON wall stats present', onRow && onRow.wallMs && near(onRow.wallMs.mean, 1100));
  // ON cost: two identical fxOn runs -> cost gross mean 300.5, cost net mean 280.
  ok('ON cost gross mean = 300.5', onRow && near(onRow.costGross.mean, 300.5));
  ok('ON cost net mean = 280', onRow && near(onRow.costNet.mean, 280));

  // OFF aggregate: gross totals 105 (clean) and 114 (dirty) -> mean 109.5 ; net 105 & 105 -> mean 105.
  const offRow = model.rows.find((r) => r.arm === 'OFF');
  ok('OFF row n = 2', offRow && offRow.n === 2);
  ok('OFF gross mean = 109.5', offRow && near(offRow.gross.mean, 109.5));
  ok('OFF net mean = 105', offRow && near(offRow.net.mean, 105));
  // OFF cost: clean in90 out15 -> 90+75=165 ; dirty work 165 + orch(in8 out1)=13 -> gross 178, net 165.
  // cost gross mean = (165+178)/2 = 171.5 ; cost net mean = 165.
  ok('OFF cost gross mean = 171.5', offRow && near(offRow.costGross.mean, 171.5));
  ok('OFF cost net mean = 165', offRow && near(offRow.costNet.mean, 165));

  // Ratios: net ON/OFF = 160/105 ; gross ON/OFF = 177/109.5.
  const ratio = model.ratios.find((r) => r.problem === 'greenfield');
  ok('ratio computed for greenfield (both arms)', ratio && ratio.haveBoth);
  ok('net ON/OFF ratio = 160/105', ratio && near(ratio.netOnOverOff, 160 / 105));
  ok('gross ON/OFF ratio = 177/109.5', ratio && near(ratio.grossOnOverOff, 177 / 109.5));
  // Cost-weighted ratios differ from raw ratios (output is weighted 5x), proving the cost view is distinct.
  ok('cost net ON/OFF ratio = 280/165', ratio && near(ratio.costNetOnOverOff, 280 / 165));
  ok('cost gross ON/OFF ratio = 300.5/171.5', ratio && near(ratio.costGrossOnOverOff, 300.5 / 171.5));
  ok('cost ratio differs from raw ratio', ratio && !near(ratio.costGrossOnOverOff, ratio.grossOnOverOff));

  // --- (4) solved===false is dropped from aggregates but reported. ---
  const model2 = buildReport([
    { problem: 'p', arm: 'ON', trial: 1, transcriptPath: fxOn, solved: true },
    { problem: 'p', arm: 'ON', trial: 2, transcriptPath: fxOn, solved: false },
  ]);
  const pRow = model2.rows.find((r) => r.arm === 'ON');
  ok('unsolved run dropped from aggregate (n=1)', pRow && pRow.n === 1);
  ok('dropped run reported', model2.dropped.length === 1 && model2.dropped[0].trial === 2);

  // --- (5) unreadable transcript is reported, not crashed on. ---
  const model3 = buildReport([{ problem: 'p', arm: 'ON', trial: 1, transcriptPath: path.join(tmp, 'nope.jsonl'), solved: true }]);
  ok('missing transcript reported as unreadable', model3.unreadable.length === 1);

  // --- (6) v4 decomposition: explorer count + W/H math on a single transcript. ---
  // One assistant msg with usage {out:500} and 3 tool_use blocks (Read, Bash, Notify) -> 2 are corroborators.
  const fxV4 = write('v4.jsonl', [
    JSON.stringify({ message: { role: 'assistant', usage: { input_tokens: 50, output_tokens: 500 },
      content: [
        { type: 'text', text: 'hi' },
        { type: 'tool_use', name: 'Read', input: {} },
        { type: 'tool_use', name: 'Bash', input: {} },
        { type: 'tool_use', name: 'Notify', input: {} }, // not a corroborator
      ] } }),
  ]);
  const sv = readSplit(fxV4);
  ok('explorers counts only EXPLORE_TOOLS (Read+Bash=2)', sv.explorers === 2);
  ok('v4 output captured = 500', sv.gross.output === 500);
  // H = max(0, out - W); with diffTokens=100 -> H=400.
  const mv4 = buildReport([{ problem: 'pv', arm: 'ON', trial: 1, transcriptPath: fxV4, solved: true, diffTokens: 100 }]);
  const pvRow = mv4.rows.find((r) => r.arm === 'ON');
  ok('v4 W mean = 100 (diffTokens)', pvRow && near(pvRow.W.mean, 100));
  ok('v4 H mean = 400 (out 500 - W 100)', pvRow && near(pvRow.H.mean, 400));
  ok('v4 explorers mean = 2', pvRow && near(pvRow.explorers.mean, 2));
  ok('H clamps at 0 when W > out', near(Math.max(0, 50 - 999), 0)); // sanity of the clamp form

  // --- (7) WIN case: a problem that PASSES all four guards. ---
  // OFF: out=500, W=100 -> H=400. ON: out=200, W=100 -> H=100. C=0 (equal cache). 2 trials each.
  // METRIC = (400-100)*5 - 0 = 1500. Cost-weighted H: off=2000, on=500. pooled over [2000,2000,500,500]:
  //   mean 1250, var = 4*750^2/3 = 750000, stdev ~866.0 -> 1500 > 866 PASS. precondition 400>=200 PASS.
  //   corroboration 100/100=1.0<=1.1 PASS. solve 1.0/1.0 PASS.
  const fxWinOff = write('win-off.jsonl', [JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 500 } } })]);
  const fxWinOn  = write('win-on.jsonl',  [JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 200 } } })]);
  const winResults = [
    { problem: 'win', arm: 'OFF', trial: 1, transcriptPath: fxWinOff, solved: true, diffTokens: 100 },
    { problem: 'win', arm: 'OFF', trial: 2, transcriptPath: fxWinOff, solved: true, diffTokens: 100 },
    { problem: 'win', arm: 'ON',  trial: 1, transcriptPath: fxWinOn,  solved: true, diffTokens: 100 },
    { problem: 'win', arm: 'ON',  trial: 2, transcriptPath: fxWinOn,  solved: true, diffTokens: 100 },
  ];
  const winModel = buildReport(winResults);
  const winV4 = winModel.v4.find((v) => v.problem === 'win');
  ok('WIN: C = 0 (equal cache cost)', winV4 && near(winV4.C, 0));
  ok('WIN: METRIC = 1500', winV4 && near(winV4.metric, 1500));
  ok('WIN: pooled stdev ~866.0', winV4 && Math.abs(winV4.pooledStdev - 866.0254) < 0.1);
  ok('WIN: precondition PASS (H_off 400 >= 2*W_off 200)', winV4 && winV4.guards.precondition === true);
  ok('WIN: fairness PASS', winV4 && winV4.guards.fairness === true);
  ok('WIN: margin PASS (1500 > pooled stdev)', winV4 && winV4.guards.margin === true);
  ok('WIN: corroboration PASS (W ratio 1.0)', winV4 && winV4.guards.corroboration === true);
  ok('WIN: overall WIN', winV4 && winV4.win === true);

  // --- (8) FAIL case: same shape but H_off < 2*W_off -> precondition FAILS, so NO-WIN. ---
  // OFF: out=300, W=200 -> H=100; 2*W_off=400 > 100 -> precondition FAIL. (other guards irrelevant.)
  const fxFailOff = write('fail-off.jsonl', [JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 300 } } })]);
  const fxFailOn  = write('fail-on.jsonl',  [JSON.stringify({ message: { usage: { input_tokens: 10, output_tokens: 200 } } })]);
  const failResults = [
    { problem: 'fail', arm: 'OFF', trial: 1, transcriptPath: fxFailOff, solved: true, diffTokens: 200 },
    { problem: 'fail', arm: 'OFF', trial: 2, transcriptPath: fxFailOff, solved: true, diffTokens: 200 },
    { problem: 'fail', arm: 'ON',  trial: 1, transcriptPath: fxFailOn,  solved: true, diffTokens: 200 },
    { problem: 'fail', arm: 'ON',  trial: 2, transcriptPath: fxFailOn,  solved: true, diffTokens: 200 },
  ];
  const failV4 = buildReport(failResults).v4.find((v) => v.problem === 'fail');
  ok('FAIL: precondition FAIL (H_off 100 < 2*W_off 400)', failV4 && failV4.guards.precondition === false);
  ok('FAIL: overall NO-WIN', failV4 && failV4.win === false);

  // --- (9) fairness guard: a low solve-rate arm fails fairness even with strong METRIC. ---
  // Reuse the WIN transcripts but add an unsolved ON trial so ON solve-rate = 2/3 < 0.8.
  const fairResults = winResults.map((r) => ({ ...r, problem: 'fair' })).concat([
    { problem: 'fair', arm: 'ON', trial: 3, transcriptPath: fxWinOn, solved: false, diffTokens: 100 },
  ]);
  const fairV4 = buildReport(fairResults).v4.find((v) => v.problem === 'fair');
  ok('FAIRNESS: solve ON = 2/3', fairV4 && near(fairV4.solveOn, 2 / 3));
  ok('FAIRNESS: fairness guard FAIL', fairV4 && fairV4.guards.fairness === false);
  ok('FAIRNESS: overall NO-WIN despite strong METRIC', fairV4 && fairV4.win === false && fairV4.metric > 0);
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
