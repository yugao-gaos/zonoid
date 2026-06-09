#!/usr/bin/env node
// Plain Node test for context-edge relevance weights in lib/overlay.js (no framework; matches
// test/native-write.test.js style). Run: node test/weighted-edges.test.js — exits non-zero on any
// failed assertion. Covers: weighted context edge round-trips, default-weight back-compat,
// add_dependency passes weight through, blocking edges carry no weight.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const ov = require('../lib/overlay');
const { TOOLS } = require('../lib/mcp-core');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Isolate overlay persistence to a throwaway data dir so we never touch real overlays.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'weighted-edges-'));
process.env.CLAUDE_PLUGIN_DATA = TMP;
const WS = '/fake/workspace/weighted-edges';

try {
  // --- context edge created with weight=0.8 persists and round-trips through disk ---
  let o = ov.EMPTY();
  ov.addEdge(o, 'a', 'b', null, 'context', 0.8);
  ov.save(WS, o);
  const reloaded = ov.load(WS);
  const e = reloaded.edges.find((x) => x.from === 'a' && x.to === 'b');
  ok('weighted context edge persisted', !!e && e.kind === 'context');
  ok('weight 0.8 round-trips from disk', e.weight === 0.8);
  ok('edgeWeight reads stored 0.8', ov.edgeWeight(e) === 0.8);

  // --- context edge with no weight reads the default ---
  let o2 = ov.EMPTY();
  ov.addEdge(o2, 'c', 'd', null, 'context');
  ov.save(WS, o2);
  const r2 = ov.load(WS);
  const e2 = r2.edges.find((x) => x.from === 'c' && x.to === 'd');
  ok('unweighted context edge stores no weight field', e2 && e2.weight === undefined);
  ok('edgeWeight returns DEFAULT_CONTEXT_WEIGHT when absent', ov.edgeWeight(e2) === ov.DEFAULT_CONTEXT_WEIGHT);
  ok('default weight is 0.5', ov.DEFAULT_CONTEXT_WEIGHT === 0.5);

  // pre-existing edge object with no weight (simulating an overlay written before this change)
  ok('legacy context edge {kind:context} reads default', ov.edgeWeight({ from: 'x', to: 'y', kind: 'context' }) === 0.5);

  // weight is clamped to [0,1]
  let o3 = ov.EMPTY();
  ov.addEdge(o3, 'e', 'f', null, 'context', 5);
  ok('over-range weight clamped to 1', o3.edges.find((x) => x.from === 'e').weight === 1);

  // --- blocking edges unaffected: no weight stored, edgeWeight is null ---
  let o4 = ov.EMPTY();
  ov.addEdge(o4, 'g', 'h', null, 'blocking', 0.9); // weight ignored for blocking
  const be = o4.edges.find((x) => x.from === 'g');
  ok('blocking edge stores no weight even if passed', be && be.weight === undefined && be.kind === undefined);
  ok('edgeWeight is null for blocking edge', ov.edgeWeight(be) === null);

  // upgrade blocking -> context on re-add sets the weight
  let o5 = ov.EMPTY();
  ov.addEdge(o5, 'i', 'j', null, 'blocking');
  ov.addEdge(o5, 'i', 'j', null, 'context', 0.7);
  const ue = o5.edges.find((x) => x.from === 'i');
  ok('blocking upgraded to context picks up weight', ue.kind === 'context' && ue.weight === 0.7);

  // --- add_dependency MCP tool passes weight through to /overlay/edge ---
  const addDep = TOOLS.find((t) => t.name === 'add_dependency');
  ok('add_dependency tool exists', !!addDep);
  ok('add_dependency inputSchema declares weight:number', addDep.inputSchema.properties.weight && addDep.inputSchema.properties.weight.type === 'number');
  let captured = null;
  const fakeCall = (method, p, body) => { captured = { method, p, body }; return { ok: true }; };
  addDep.run({ from: 'a', to: 'b', kind: 'context', weight: 0.8 }, fakeCall);
  ok('add_dependency POSTs to /overlay/edge', captured.p === '/overlay/edge');
  ok('add_dependency forwards weight=0.8', captured.body.weight === 0.8);
  // omitted weight ⇒ undefined forwarded (server applies default), behaves as before
  addDep.run({ from: 'a', to: 'b', kind: 'context' }, fakeCall);
  ok('add_dependency forwards undefined weight when omitted', captured.body.weight === undefined);
} finally {
  fs.rmSync(TMP, { recursive: true, force: true });
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
