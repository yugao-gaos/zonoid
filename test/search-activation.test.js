#!/usr/bin/env node
// Plain Node tests for the pure weighted graph activation engine.
'use strict';

const { activateGraph } = require('../lib/search/activation');

let pass = 0, fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};
const byKey = (rows, key) => rows.find((r) => r.key === key);
const approx = (actual, expected, epsilon = 1e-9) => Math.abs(actual - expected) <= epsilon;

// Weight-0 and explicitly unjudged edges are retrieval-invisible.
{
  const rows = activateGraph({
    seeds: { query: 1 },
    includeSeeds: false,
    maxDepth: 1,
    decay: 1,
    adjacency: {
      query: [
        { to: 'visible', relation: 'context', weight: 0.8, judged: true },
        { to: 'zero-weight', relation: 'context', weight: 0, judged: true },
        { to: 'unjudged', relation: 'context', weight: 0.9, judged: false },
      ],
    },
  });

  ok('visible edge activates', !!byKey(rows, 'visible'));
  ok('weight-0 edge does not activate', !byKey(rows, 'zero-weight'));
  ok('unjudged edge does not activate', !byKey(rows, 'unjudged'));
}

// Activation decays over hops and preserves best path/depth provenance.
{
  const rows = activateGraph({
    seeds: { a: 1 },
    includeSeeds: false,
    maxDepth: 2,
    decay: 0.5,
    adjacency: {
      a: [{ to: 'b', weight: 1, judged: true }],
      b: [{ to: 'c', weight: 1, judged: true }],
    },
  });
  const b = byKey(rows, 'b');
  const c = byKey(rows, 'c');

  ok('one-hop activation decays once', approx(b.activation, 0.5));
  ok('two-hop activation decays twice', approx(c.activation, 0.25));
  ok('two-hop node records depth', c.depth === 2);
  ok('two-hop node records path', c.path.join('>') === 'a>b>c');
  ok('provenance records seed and edges', c.provenance.length === 3 && c.provenance[0].type === 'seed' && c.provenance[2].to === 'c');
}

// Seed confidence, edge confidence, relation weights, and edge weights all multiply activation.
{
  const rows = activateGraph({
    seeds: [{ key: 'seed', activation: 1, confidence: 0.5 }],
    includeSeeds: false,
    maxDepth: 1,
    decay: 1,
    relationWeights: { context: 0.5 },
    adjacency: {
      seed: [{ to: 'weighted', relation: 'context', weight: 0.8, confidence: 0.5, judged: true }],
    },
  });
  const weighted = byKey(rows, 'weighted');

  ok('confidence and weights are applied', approx(weighted.activation, 0.1));
  ok('relation weight appears in provenance', weighted.provenance[1].relationWeight === 0.5);
}

// A semantically weak seed can surface a strongly wired neighbour above a looser semantic hit.
{
  const rows = activateGraph({
    seeds: [
      { key: 'loose-semantic-hit', activation: 0.34, source: 'semantic' },
      { key: 'weak-semantic-anchor', activation: 0.22, source: 'semantic' },
    ],
    maxDepth: 1,
    budget: 2,
    decay: 0.9,
    relationWeights: { context: 1.8 },
    adjacency: {
      'weak-semantic-anchor': [
        { to: 'strong-wired-neighbor', relation: 'context', weight: 1, confidence: 1, judged: true },
      ],
    },
  });

  ok('budget limits result count', rows.length === 2);
  ok('strong wired neighbor ranks first', rows[0].key === 'strong-wired-neighbor');
  ok('strong wired neighbor beats looser semantic hit', rows[0].activation > byKey(rows, 'loose-semantic-hit').activation);
  ok('strong wired neighbor path starts at weak seed', rows[0].path.join('>') === 'weak-semantic-anchor>strong-wired-neighbor');

  const unbounded = activateGraph({
    seeds: { a: 1 },
    budget: Infinity,
    maxDepth: 1,
    adjacency: { a: [{ to: 'b', weight: 1, judged: true }] },
  });
  ok('explicit Infinity budget is unbounded', unbounded.length === 2);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
