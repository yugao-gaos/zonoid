#!/usr/bin/env node
// Plain Node test for ACTION-AWARE guidance resolution — the decision effects /guidance/resolve
// applies, modeled over the same pure overlay + judge primitives the route uses (so it tests the real
// logic without binding a port). Run: node test/guidance-resolve.test.js.
//
// Properties:
//   - addGuidance persists an optional `action` payload (absent ⇒ plain text item, back-compat).
//   - resolve dup-cluster + 'consolidate' supersedes non-keepers into the keeper, re-points context
//     edges, drops self-loops/dups, and stamps the cluster judged (the keeper inherits the edges).
//   - resolve dup-cluster + 'distinct' marks the signature DISTINCT so dupClusters skips it forever.
//   - resolve generic records the text answer (back-compat).
//   - dupClusters drops any cluster whose signature was marked distinct.
'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// Faithful re-implementation of the route's resolve handler decision logic (mirrors daemon
// /guidance/resolve). Operates on the overlay + the guidance item carrying an `action`.
function applyResolve(overlay, body) {
  const item = (overlay.guidance || []).find((g) => g.id === body.id);
  if (!item) return { ok: false };
  const action = item.action || null;
  const result = { ok: true };
  if (action && action.kind === 'dup-cluster' && (body.decision === 'consolidate' || body.decision === 'distinct')) {
    const keys = (action.keys || []).map((k) => String(k).startsWith('note:') ? String(k) : 'note:' + k);
    if (body.decision === 'distinct') {
      ov.markClusterDistinct(overlay, keys);
      result.decision = 'distinct';
    } else {
      let keepKeyRaw = body.keep ? String(body.keep) : null;
      if (!keepKeyRaw) {
        const sorted = keys.slice().sort((ka, kb) => {
          const na = overlay.note_nodes[ka.replace(/^note:/, '')];
          const nb = overlay.note_nodes[kb.replace(/^note:/, '')];
          return Date.parse((na && na.created_at) || 0) - Date.parse((nb && nb.created_at) || 0);
        });
        keepKeyRaw = sorted[sorted.length - 1] || keys[0];
      }
      const keep = String(keepKeyRaw).replace(/^note:/, '');
      const keepKey = 'note:' + keep;
      const supersededNow = [];
      for (const oldKey of keys) {
        if (oldKey === keepKey) continue;
        const oldId = String(oldKey).replace(/^note:/, '');
        const r = ov.supersedeNote(overlay, oldId, keep);
        if (r && r.ok) supersededNow.push('note:' + oldId);
      }
      for (const e of overlay.edges) {
        if (e.kind !== 'context') continue;
        if (supersededNow.includes(e.from)) e.from = keepKey;
        if (supersededNow.includes(e.to)) e.to = keepKey;
      }
      const seen = new Set();
      overlay.edges = overlay.edges.filter((e) => {
        if (e.from === e.to) return false;
        const sig = `${e.from}>>${e.to}>>${e.fromWorkspace || ''}>>${e.kind || 'blocking'}`;
        if (seen.has(sig)) return false; seen.add(sig); return true;
      });
      if (!overlay.judgedClusters) overlay.judgedClusters = {};
      judge.stampCluster(overlay.judgedClusters, [keepKey, ...supersededNow], overlay.epoch || 0);
      result.decision = 'consolidate'; result.keep = keepKey; result.superseded = supersededNow;
    }
    ov.resolveGuidance(overlay, body.id, body.decision);
  } else {
    ov.resolveGuidance(overlay, body.id, body.answer != null ? body.answer : body.decision);
  }
  return result;
}

// Build a 3-note dup-cluster guidance item with an action payload.
function clusterFixture() {
  const o = ov.EMPTY(); o.epoch = 4;
  const keep = ov.addNoteNode(o, { title: 'keeper', summary: 'fact' });
  const old1 = ov.addNoteNode(o, { title: 'dup 1', summary: 'fact' });
  const old2 = ov.addNoteNode(o, { title: 'dup 2', summary: 'fact' });
  // Deterministic, distinct created_at so the "newest wins" default has a single unambiguous answer.
  o.note_nodes[old1].created_at = '2026-01-01T00:00:01.000Z';
  o.note_nodes[old2].created_at = '2026-01-01T00:00:02.000Z';
  o.note_nodes[keep].created_at = '2026-01-01T00:00:03.000Z';   // newest
  const keys = ['note:' + keep, 'note:' + old1, 'note:' + old2];
  o.edges = [
    { from: 'note:' + old1, to: 's/consumer', kind: 'context', weight: 0.6 },
    { from: 'note:' + old2, to: 's/task', kind: 'context', weight: 0.5 },
    { from: 'note:' + keep, to: 's/task', kind: 'context', weight: 0.5 },
    { from: 'note:' + old1, to: 'note:' + keep, kind: 'context' },
    { from: 's/x', to: 's/y' },
  ];
  const id = ov.addGuidance(o, {
    question: 'cluster?', context: 'amb', trigger: 'ambiguous_intent', severity: 'review',
    action: { kind: 'dup-cluster', keys, signature: judge.clusterSignature(keys),
      notes: keys.map((k) => ({ key: k, title: o.note_nodes[k.replace(/^note:/, '')].title, created_at: o.note_nodes[k.replace(/^note:/, '')].created_at })) },
  });
  return { o, id, keep, old1, old2, keys };
}

// --- addGuidance persists the action payload --------------------------------------------------
{
  const { o, id } = clusterFixture();
  const it = o.guidance.find((g) => g.id === id);
  ok('addGuidance persists action payload', !!it.action && it.action.kind === 'dup-cluster' && it.action.keys.length === 3);
  ok('action carries per-note titles for the picker', it.action.notes.every((n) => n.title));
  const plain = ov.addGuidance(o, { question: 'plain?' });
  ok('addGuidance without action stays plain (back-compat)', !o.guidance.find((g) => g.id === plain).action);
}

// --- resolve consolidate: supersede non-keepers + re-point edges ------------------------------
{
  const { o, id, keep, old1, old2 } = clusterFixture();
  const r = applyResolve(o, { id, decision: 'consolidate', keep: 'note:' + keep });
  ok('consolidate supersedes the non-keepers', o.note_nodes[old1].validTo != null && o.note_nodes[old2].validTo != null);
  ok('consolidate keeps the keeper current', o.note_nodes[keep].validTo === null);
  ok('consolidate re-points old1->consumer onto keeper', o.edges.some((e) => e.from === 'note:' + keep && e.to === 's/consumer'));
  ok('consolidate drops the self-loop', !o.edges.some((e) => e.from === 'note:' + keep && e.to === 'note:' + keep));
  ok('consolidate dedups keep->s/task to one edge', o.edges.filter((e) => e.from === 'note:' + keep && e.to === 's/task').length === 1);
  ok('consolidate leaves no edge on a superseded note', !o.edges.some((e) => e.kind === 'context' && (e.from === 'note:' + old1 || e.to === 'note:' + old1 || e.from === 'note:' + old2 || e.to === 'note:' + old2)));
  ok('consolidate marks the item resolved', o.guidance.find((g) => g.id === id).resolved === true);
  ok('consolidate result reports keeper', r.decision === 'consolidate' && r.keep === 'note:' + keep);
}

// --- resolve consolidate with NO keep → newest by created_at wins ------------------------------
{
  const { o, id, keep } = clusterFixture();   // keep is the newest (created last)
  applyResolve(o, { id, decision: 'consolidate' });
  ok('consolidate w/o keep keeps the newest note current', o.note_nodes[keep].validTo === null);
}

// --- resolve distinct: mark signature, dupClusters skips forever ------------------------------
{
  const { o, id, keys } = clusterFixture();
  ok('cluster is distinct-flagged false before resolve', ov.isClusterDistinct(o, keys) === false);
  applyResolve(o, { id, decision: 'distinct' });
  ok('distinct marks the cluster signature', ov.isClusterDistinct(o, keys) === true);
  ok('distinct marks the item resolved', o.guidance.find((g) => g.id === id).resolved === true);
  ok('distinct does NOT supersede any note', keys.every((k) => o.note_nodes[k.replace(/^note:/, '')].validTo === null));
}

// --- generic item: text answer recorded (back-compat) -----------------------------------------
{
  const o = ov.EMPTY();
  const id = ov.addGuidance(o, { question: 'pick a or b?' });
  applyResolve(o, { id, decision: 'use option a' });
  const it = o.guidance.find((g) => g.id === id);
  ok('generic resolve records the text answer', it.resolved === true && it.answer === 'use option a');
}

// --- dupClusters SKIPS a distinct-marked signature --------------------------------------------
{
  // Two near-identical vecs → one recall cluster. Mark it distinct → dupClusters returns nothing.
  const o = ov.EMPTY();
  const a = ov.addNoteNode(o, { title: 'a', summary: 'x', vec: [1, 0, 0] });
  const b = ov.addNoteNode(o, { title: 'b', summary: 'x', vec: [0.99, 0.01, 0] });
  const before = judge.dupClusters(o);
  ok('dupClusters surfaces the recall cluster before distinct', before.length === 1 && before[0].length === 2);
  ov.markClusterDistinct(o, before[0]);
  const after = judge.dupClusters(o);
  ok('dupClusters SKIPS the cluster after marking distinct', after.length === 0);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
