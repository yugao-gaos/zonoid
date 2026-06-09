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
const { readSplit, stats, buildReport } = require('./bench-report.js');

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

  // OFF aggregate: gross totals 105 (clean) and 114 (dirty) -> mean 109.5 ; net 105 & 105 -> mean 105.
  const offRow = model.rows.find((r) => r.arm === 'OFF');
  ok('OFF row n = 2', offRow && offRow.n === 2);
  ok('OFF gross mean = 109.5', offRow && near(offRow.gross.mean, 109.5));
  ok('OFF net mean = 105', offRow && near(offRow.net.mean, 105));

  // Ratios: net ON/OFF = 160/105 ; gross ON/OFF = 177/109.5.
  const ratio = model.ratios.find((r) => r.problem === 'greenfield');
  ok('ratio computed for greenfield (both arms)', ratio && ratio.haveBoth);
  ok('net ON/OFF ratio = 160/105', ratio && near(ratio.netOnOverOff, 160 / 105));
  ok('gross ON/OFF ratio = 177/109.5', ratio && near(ratio.grossOnOverOff, 177 / 109.5));

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
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
