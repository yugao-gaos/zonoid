#!/usr/bin/env node
// Sample legacy kept edges for LLM calibration pilot (task #30).
// Reads /tmp/state-out.json, stratifies by cosine proxy at 0.55,
// draws 50 random from each stratum, prints JSON to stdout.
'use strict';
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('/tmp/state-out.json', 'utf8'));
const tasks = d.tasks || [];
const edges = d.edges || [];
const ctx = edges.filter(function(e) { return e.kind === 'context'; });
const legacy = ctx.filter(function(e) {
  return e.judged === true && typeof e.weight === 'number' && e.weight > 0 && e.origin !== 'asserted';
});
const title = {};
tasks.forEach(function(t) { title[t.id] = t.label || t.id; });
const vecOf = {};
tasks.forEach(function(t) {
  if (Array.isArray(t.vecs) && t.vecs.length && Array.isArray(t.vecs[0])) vecOf[t.id] = t.vecs;
});
function cos(a, b) {
  var dd = 0, na = 0, nb = 0;
  for (var i = 0; i < a.length; i++) { dd += a[i]*b[i]; na += a[i]*a[i]; nb += b[i]*b[i]; }
  return dd / (Math.sqrt(na) * Math.sqrt(nb) + 1e-9);
}
function bestCos(va, vb) {
  var m = -1;
  for (var i = 0; i < va.length; i++) {
    for (var j = 0; j < vb.length; j++) {
      var c = cos(va[i], vb[j]);
      if (c > m) m = c;
    }
  }
  return m;
}
const NB = 0.55;
const pruneEdges = [], keepEdges = [], noVec = [];
legacy.forEach(function(e) {
  var va = vecOf[e.from], vb = vecOf[e.to];
  if (!va || !vb) { noVec.push({ from: e.from, to: e.to }); return; }
  var c = bestCos(va, vb);
  var row = {
    from: e.from, to: e.to,
    fT: String(title[e.from] || e.from).slice(0, 80),
    tT: String(title[e.to] || e.to).slice(0, 80),
    weight: e.weight, cos: c, score: e.score
  };
  if (c < NB) pruneEdges.push(row); else keepEdges.push(row);
});
// Deterministic shuffle (sin-based LCG)
function shuffle(n, seed) {
  var arr = [];
  for (var i = 0; i < n; i++) arr.push(i);
  for (var i = n - 1; i > 0; i--) {
    var j = Math.abs(Math.sin(seed + i) * 10000 | 0) % (i + 1);
    var tmp = arr[i]; arr[i] = arr[j]; arr[j] = tmp;
  }
  return arr;
}
var pShuffle = shuffle(pruneEdges.length, 42);
var kShuffle = shuffle(keepEdges.length, 43);
var samplePrune = pShuffle.slice(0, 50).map(function(i) { return pruneEdges[i]; });
var sampleKeep  = kShuffle.slice(0, 50).map(function(i) { return keepEdges[i]; });
var summary = {
  totalEdges: edges.length, ctxEdges: ctx.length, legacyKept: legacy.length,
  evaluable: pruneEdges.length + keepEdges.length, noVec: noVec.length,
  proxyPrune: pruneEdges.length, proxyKeep: keepEdges.length,
  samplePruneN: samplePrune.length, sampleKeepN: sampleKeep.length
};
console.log(JSON.stringify({ summary: summary, samplePrune: samplePrune, sampleKeep: sampleKeep }));
