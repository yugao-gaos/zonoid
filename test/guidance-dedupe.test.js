'use strict';
const ov = require('../lib/overlay');
const judge = require('../lib/judge');
let n = 0, f = 0;
function ok(msg, cond) { n++; if (!cond) { f++; console.error('FAIL:', msg); } else console.log('PASS:', msg); }

const o = ov.EMPTY();
const action = { kind: 'dup-cluster', keys: ['note:a', 'note:b'], signature: 'note:a|note:b', notes: [] };
const id1 = ov.addGuidance(o, { question: 'q1', context: 'c1', trigger: 'ambiguous_intent', severity: 'review', action });
const id2 = ov.addGuidance(o, { question: 'q2', context: 'c2', trigger: 'ambiguous_intent', severity: 'review', action });
ok('dup-cluster guidance coalesces to one pending row', id1 === id2 && o.guidance.filter((g) => !g.resolved).length === 1);

o.guidance.push({ id: 'g-old1', resolved: false, action: { kind: 'dup-cluster', keys: ['note:x', 'note:y'], signature: 'note:x|note:y' } });
o.guidance.push({ id: 'g-old2', resolved: false, action: { kind: 'dup-cluster', keys: ['note:y', 'note:x'], signature: 'note:x|note:y' } });
const collapsed = ov.dedupeGuidanceClusters(o);
ok('dedupeGuidanceClusters collapses duplicate signatures', collapsed.length === 1);
ok('one pending row per cluster signature remains', o.guidance.filter((g) => !g.resolved && g.action && g.action.kind === 'dup-cluster').length === 2);

console.log('-----\n' + (n - f) + ' passed, ' + f + ' failed');
process.exit(f ? 1 : 0);

{
  const o = ov.EMPTY();
  o.note_nodes['note-old'] = { id: 'note-old', title: 'checklist', validTo: '2026-06-10T16:00:00Z', supersededBy: 'note-new' };
  o.note_nodes['note-new'] = { id: 'note-new', title: 'merged', validTo: null, supersedes: 'note-old', created_at: '2026-06-10T16:01:00Z' };
  o.guidance.push({
    id: 'g-settled', resolved: false,
    action: { kind: 'dup-cluster', keys: ['note:note-old', 'note:note-new'], signature: 'note:note-new|note:note-old' },
  });
  ok('clusterConsolidationState sees supersede chain', judge.clusterConsolidationState(o, ['note:note-old', 'note:note-new'])?.keeper === 'note:note-new');
  const settled = judge.resolveSettledClusterGuidance(o);
  ok('resolveSettledClusterGuidance auto-closes stale dup-cluster row', settled.length === 1 && o.guidance[0].resolved === true);
}
