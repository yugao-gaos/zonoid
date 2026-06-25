'use strict';
// HELD-OUT grader for the ctl-stale-claims CONTROL candidate. The agent NEVER sees this file.
// CONTROL: every rule (strict >, missing-heartbeat-is-stale, ordering, status/agent filters) is
// stated in the spec. The related graph note (stale-item self-heal principle) is decorative.
// "Edge" rows are the trickier spec-stated boundaries; both arms are expected to pass them.
const fs = require('fs');
const path = require('path');

const artifact = process.argv[2];
if (!artifact || !fs.existsSync(artifact)) {
  console.log(JSON.stringify({ ok: false, error: 'artifact missing: ' + artifact, cases: [], pass: 0, total: 0, edgePass: 0, edgeTotal: 0 }));
  process.exit(0);
}
let findStaleClaims, loadErr = null;
try { ({ findStaleClaims } = require(path.resolve(artifact))); } catch (e) { loadErr = e.message; }

const eq = (a, b) => Array.isArray(a) && a.length === b.length && a.every((v, i) => v === b[i]);
const cases = [];
function run(name, edge, fn) {
  let pass = false, err = null;
  if (typeof findStaleClaims !== 'function') err = loadErr || 'no findStaleClaims export';
  else { try { pass = !!fn(); } catch (e) { err = e.message; } }
  cases.push({ name, edge, pass, err });
}

run('public example', false, () => eq(findStaleClaims([
  { id: 'a', status: 'in_progress', agent: 'x', lastHeartbeatMs: 1000 },
  { id: 'b', status: 'done', agent: 'x', lastHeartbeatMs: 1000 },
  { id: 'c', status: 'in_progress', agent: 'y', lastHeartbeatMs: 9000 },
], 10000, 5000), ['a']));
run('empty input -> empty', false, () => eq(findStaleClaims([], 10000, 5000), []));
run('no agent -> not stale', false, () => eq(findStaleClaims([
  { id: 'a', status: 'in_progress', agent: null, lastHeartbeatMs: 0 },
  { id: 'b', status: 'in_progress', agent: '', lastHeartbeatMs: 0 },
], 10000, 100), []));
run('pending never stale', false, () => eq(findStaleClaims([
  { id: 'a', status: 'pending', agent: 'x', lastHeartbeatMs: 0 },
], 10000, 100), []));

run('exact boundary age == staleMs is NOT stale', true, () => eq(findStaleClaims([
  { id: 'a', status: 'in_progress', agent: 'x', lastHeartbeatMs: 5000 },
], 10000, 5000), []));
run('one past boundary IS stale', true, () => eq(findStaleClaims([
  { id: 'a', status: 'in_progress', agent: 'x', lastHeartbeatMs: 4999 },
], 10000, 5000), ['a']));
run('missing heartbeat counts as stale', true, () => eq(findStaleClaims([
  { id: 'a', status: 'in_progress', agent: 'x' },
], 10000, 5000), ['a']));
run('null heartbeat counts as stale', true, () => eq(findStaleClaims([
  { id: 'a', status: 'in_progress', agent: 'x', lastHeartbeatMs: null },
], 10000, 5000), ['a']));
run('oldest first ordering', true, () => eq(findStaleClaims([
  { id: 'a', status: 'in_progress', agent: 'x', lastHeartbeatMs: 3000 },
  { id: 'b', status: 'in_progress', agent: 'y', lastHeartbeatMs: 1000 },
  { id: 'c', status: 'in_progress', agent: 'z', lastHeartbeatMs: 2000 },
], 10000, 500), ['b', 'c', 'a']));
run('missing heartbeats first, in input order', true, () => eq(findStaleClaims([
  { id: 'a', status: 'in_progress', agent: 'x', lastHeartbeatMs: 1000 },
  { id: 'b', status: 'in_progress', agent: 'y' },
  { id: 'c', status: 'in_progress', agent: 'z', lastHeartbeatMs: null },
], 10000, 500), ['b', 'c', 'a']));
run('done with ancient heartbeat not stale', true, () => eq(findStaleClaims([
  { id: 'a', status: 'done', agent: 'x', lastHeartbeatMs: 0 },
], 1e9, 100), []));

const pass = cases.filter((c) => c.pass).length;
const edge = cases.filter((c) => c.edge);
const edgePass = edge.filter((c) => c.pass).length;
console.log(JSON.stringify({ ok: pass === cases.length, cases, pass, total: cases.length, edgePass, edgeTotal: edge.length }));
