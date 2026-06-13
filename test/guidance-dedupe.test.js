'use strict';
const ov = require('../lib/overlay');
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
