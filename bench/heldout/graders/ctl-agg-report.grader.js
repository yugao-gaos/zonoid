'use strict';
// HELD-OUT grader for the ctl-agg-report CONTROL candidate. The agent NEVER sees this file.
// CONTROL: mean/median/skip/empty rules are all stated in the spec. The related graph note
// (benchmark design) is decorative. "Edge" rows are the trickier spec-stated boundaries; both
// arms are expected to pass them.
const fs = require('fs');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}
let summarizeRuns, loadErr = null;
try { ({ summarizeRuns } = require(path.resolve(artifact))); } catch (e) { loadErr = e.message; }

const close = (a, b) => typeof a === 'number' && Math.abs(a - b) < 0.005;
const cases = [];
function run(name, edge, fn) {
  let pass = false, err = null;
  if (typeof summarizeRuns !== 'function') err = loadErr || 'no summarizeRuns export';
  else { try { pass = !!fn(); } catch (e) { err = e.message; } }
  cases.push({ name, edge, pass, err });
}

run('public example', false, () => {
  const r = summarizeRuns([{ arm: 'on', tokens: 10 }, { arm: 'on', tokens: 20 }, { arm: 'off', tokens: 7 }]);
  return r && r.on && r.on.n === 2 && close(r.on.mean, 15) && close(r.on.median, 15)
    && r.off && r.off.n === 1 && close(r.off.mean, 7) && close(r.off.median, 7);
});
run('empty -> {}', false, () => {
  const r = summarizeRuns([]);
  return r && typeof r === 'object' && Object.keys(r).length === 0;
});
run('single row', false, () => {
  const r = summarizeRuns([{ arm: 'a', tokens: 3 }]);
  return r && r.a && r.a.n === 1 && close(r.a.mean, 3) && close(r.a.median, 3);
});

run('odd median is middle value', true, () => {
  const r = summarizeRuns([{ arm: 'a', tokens: 9 }, { arm: 'a', tokens: 1 }, { arm: 'a', tokens: 5 }]);
  return r && r.a && close(r.a.median, 5);
});
run('even median averages two middles', true, () => {
  const r = summarizeRuns([{ arm: 'a', tokens: 1 }, { arm: 'a', tokens: 2 }, { arm: 'a', tokens: 10 }, { arm: 'a', tokens: 4 }]);
  return r && r.a && close(r.a.median, 3);
});
run('mean rounded to 2dp', true, () => {
  const r = summarizeRuns([{ arm: 'a', tokens: 1 }, { arm: 'a', tokens: 2 }, { arm: 'a', tokens: 2 }]);
  return r && r.a && close(r.a.mean, 1.67);
});
run('non-finite tokens skipped', true, () => {
  const r = summarizeRuns([
    { arm: 'a', tokens: 5 }, { arm: 'a', tokens: NaN }, { arm: 'a' },
    { arm: 'a', tokens: 'x' }, { arm: 'a', tokens: Infinity },
  ]);
  return r && r.a && r.a.n === 1 && close(r.a.mean, 5);
});
run('arm with only bad rows omitted', true, () => {
  const r = summarizeRuns([{ arm: 'a', tokens: 5 }, { arm: 'b', tokens: NaN }]);
  return r && r.a && !('b' in r);
});
run('all rows skipped -> {}', true, () => {
  const r = summarizeRuns([{ arm: 'b', tokens: NaN }, { arm: 'c' }]);
  return r && Object.keys(r).length === 0;
});

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({ ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length }));
