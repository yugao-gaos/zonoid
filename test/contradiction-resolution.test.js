#!/usr/bin/env node
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');

const ov = require('../lib/overlay');
const judge = require('../lib/judge');

const DIMS = 384;
const vec = (x) => {
  const v = new Array(DIMS).fill(0);
  v[0] = x;
  v[1] = Math.sqrt(1 - x * x);
  return v;
};

function withEnv(key, value, fn) {
  const prev = process.env[key];
  if (value == null) delete process.env[key];
  else process.env[key] = value;
  return Promise.resolve()
    .then(fn)
    .finally(() => {
      if (prev == null) delete process.env[key];
      else process.env[key] = prev;
    });
}

test('contradiction resolution stays gated and feeds the pending-dup dup-cluster path', async () => {
  await withEnv('ZONOID_CONTRADICTION_RESOLUTION', undefined, async () => {
    assert.equal(judge.contradictionResolutionEnabled(), false, 'gate is OFF by default');
  });

  await withEnv('ZONOID_CONTRADICTION_RESOLUTION', '1', async () => {
    assert.equal(judge.contradictionResolutionEnabled(), true, 'gate turns ON when enabled');

    const overlay = ov.EMPTY();
    const keep = ov.addNoteNode(overlay, {
      title: 'deployment target',
      summary: 'the daemon currently deploys to render',
      valid_from: '2026-01-01T00:00:00.000Z',
      vec: vec(1),
    });
    const candidate = ov.addNoteNode(overlay, {
      title: 'deployment target updated',
      summary: 'the daemon now deploys to railway',
      valid_from: '2026-01-02T00:00:00.000Z',
      vec: vec(0.85),
    });

    const cands = judge.findContradictionCandidates(candidate, vec(0.85), overlay);
    assert.equal(cands.length, 1, 'one contradiction candidate is found');
    assert.equal(cands[0].noteId, keep, 'the older note is selected');
    assert(cands[0].similarity >= judge.CONTRADICTION_BAND_LOW, 'candidate is inside the contradiction band');
    assert(cands[0].similarity < 0.92, 'candidate stays below the subsumption ceiling');

    assert.equal(judge.findContradictionCandidates(candidate, vec(0.79), overlay).length, 0, 'below band stays out');
    assert.equal(judge.findContradictionCandidates(candidate, vec(0.95), overlay).length, 0, 'subsumption band stays out');

    ov.markPendingDup(overlay, `note:${candidate}`, `note:${keep}`, cands[0].similarity);
    ov.bumpEpoch(overlay);
    const clusters = judge.pendingDupClusters(overlay);
    assert.equal(clusters.length, 1, 'pending-dup pair surfaces as a dup-cluster');
    assert.deepEqual(clusters[0], [`note:${candidate}`, `note:${keep}`].sort(), 'cluster contains the note pair');
    assert(judge.buildQueue(overlay).some((item) => item.kind === 'dup-cluster'), 'dup-cluster reaches the judge queue');
  });
});
