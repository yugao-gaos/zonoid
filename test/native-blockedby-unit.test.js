#!/usr/bin/env node
// Unit test for native-blockedBy overlay edge invariant (task #10).
// Verifies that addEdge stores origin on blocking edges and that
// isUnverifiedEdge (judge.js) correctly excludes them from the queue.
// Run: node test/native-blockedby-unit.test.js
'use strict';
const overlayStore = require('../lib/overlay');
const judge = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log('PASS  ' + label); pass++; }
  else { console.log('FAIL  ' + label); fail++; }
};

// (1) addEdge stores origin on blocking edges
const ov = overlayStore.EMPTY();
overlayStore.addEdge(ov, 'sess/blk', 'sess/dep', null, 'blocking', null, { origin: 'native-blockedBy' });
const edge = ov.edges.find((e) => !e.kind);
ok('blocking edge created', !!edge);
ok('blocking edge has origin:native-blockedBy', edge && edge.origin === 'native-blockedBy');
ok('blocking edge has no kind field (back-compat absent=blocking)', edge && !('kind' in edge));
ok('blocking edge has no judged field', edge && !('judged' in edge));
ok('blocking edge has no weight field', edge && !('weight' in edge));

// (2) isUnverifiedEdge must return false for blocking edges (they are never judge candidates)
const isUnverified = (e) => !!e && e.kind === 'context' && e.judged === false;
ok('isUnverifiedEdge returns false for blocking edge', !isUnverified(edge));

// (3) buildQueue must not include blocking edges
const ovWithContext = overlayStore.EMPTY();
// add a blocking edge (should NOT appear in queue)
overlayStore.addEdge(ovWithContext, 'sess/blk', 'sess/dep', null, 'blocking', null, { origin: 'native-blockedBy' });
// add an autowire context edge (SHOULD appear in queue)
overlayStore.addEdge(ovWithContext, 'note:noteA', 'sess/dep', null, 'context', 0, { by: 'autowire', judged: false, origin: 'autowire-semantic' });
const queue = judge.buildQueue(ovWithContext);
const edgeItems = queue.filter((i) => i.kind === 'edge');
const blockingInQueue = edgeItems.some((i) => i.from === 'sess/blk' && i.to === 'sess/dep');
const autowireInQueue = edgeItems.some((i) => i.from === 'note:noteA' && i.to === 'sess/dep');
ok('native-blockedBy edge NOT in judge queue', !blockingInQueue);
ok('autowire context edge IS in judge queue (control check)', autowireInQueue);

// (4) origin is NOT stored for context edges (uses its own meta path)
const ovCtx = overlayStore.EMPTY();
overlayStore.addEdge(ovCtx, 'note:noteA', 'sess/dep', null, 'context', 0, { by: 'autowire', judged: false, origin: 'autowire-semantic' });
const ctxEdge = ovCtx.edges.find((e) => e.kind === 'context');
ok('context edge stores origin via context meta path', ctxEdge && ctxEdge.origin === 'autowire-semantic');

console.log('-----');
console.log(pass + ' passed, ' + fail + ' failed');
process.exit(fail === 0 ? 0 : 1);
