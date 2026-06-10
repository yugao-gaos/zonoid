#!/usr/bin/env node
// Plain Node test for lib/verdicts.js — structured verdicts about EXISTING tasks on complete_task
// (no framework; matches test/followups.test.js style). Run: node test/verdicts.test.js.
//
// Properties:
//   - validate: rejects non-arrays, missing task_key/reason, unknown actions; accepts the three
//     actions (release/hold/cancel).
//   - apply (release): drops an explicit not_ready override (status re-derives), reason lands
//     FIRST in the note with the prior note kept; a target with no hold is a no-op (released:false)
//     and a non-not_ready override is never touched.
//   - apply (hold): sets/refreshes a not_ready override with the reason as note.
//   - apply (cancel): canceled override + cooperative cancel flag (existing cancel semantics).
//   - sweepStaleHolds: auto-releases a hold whose note references the completed task (full key, or
//     same-session "/<id>" shorthand — the motivating incident's "gated behind (/14)"); flags
//     unreferenced stale holds as severity-'review' guidance with action {kind:'stale-hold'};
//     leaves holds with unfinished blocking deps, 'followup/' keys, re-justified holds and
//     cross-session shorthands alone; never double-flags while a guidance item is unresolved.
//   - resolveStaleHold: 'release' drops the override; 'keep' re-justifies (sweep stops re-flagging);
//     any other answer keeps the gate closed.
//   - lintProse: warns when GO/recommend/unblock language meets a task-key-like reference with no
//     structured verdict covering it; silent when covered, when self-referential, or when there is
//     no verdict language; digit-only "sessions" (dates/fractions) don't count as keys.
'use strict';
const ov = require('../lib/overlay');
const vd = require('../lib/verdicts');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// --- validate ----------------------------------------------------------------------------------
{
  ok('validate rejects non-array', vd.validate({}) != null);
  ok('validate rejects missing task_key', vd.validate([{ action: 'release', reason: 'r' }]) != null);
  ok('validate rejects missing reason', vd.validate([{ task_key: 's/1', action: 'hold' }]) != null);
  ok('validate rejects unknown action', vd.validate([{ task_key: 's/1', action: 'approve', reason: 'r' }]) != null);
  ok('validate accepts release/hold/cancel', vd.validate([
    { task_key: 's/1', action: 'release', reason: 'gate satisfied' },
    { task_key: 's/2', action: 'hold', reason: 'regressed' },
    { task_key: 's/3', action: 'cancel', reason: 'moot' },
  ]) === null);
}

// --- apply: release ----------------------------------------------------------------------------
{
  const o = ov.EMPTY();
  ov.setStatus(o, 's/11', 'not_ready', 'HELD: gated behind /14');
  const res = vd.apply(o, 's/14', [{ task_key: 's/11', action: 'release', reason: 'GO — re-measure passed' }]);
  ok('release drops the not_ready override', o.status['s/11'] === undefined && res[0].released === true);
  ok('release note carries reason first + prior note', /^released by s\/14: GO — re-measure passed \(was: HELD: gated behind \/14\)/.test(o.notes['s/11']));
  // No hold to release → no-op, reported honestly.
  const res2 = vd.apply(o, 's/14', [{ task_key: 's/99', action: 'release', reason: 'r' }]);
  ok('release without a hold is a no-op (released:false + note)', res2[0].released === false && !!res2[0].note && o.status['s/99'] === undefined);
  // A non-not_ready override (e.g. failed) is never silently cleared.
  ov.setStatus(o, 's/7', 'failed', 'broke');
  vd.apply(o, 's/14', [{ task_key: 's/7', action: 'release', reason: 'r' }]);
  ok('release never touches a non-not_ready override', o.status['s/7'] === 'failed');
}

// --- apply: hold + cancel ----------------------------------------------------------------------
{
  const o = ov.EMPTY();
  const res = vd.apply(o, 's/2', [
    { task_key: 's/5', action: 'hold', reason: 'NO-GO: probe regressed' },
    { task_key: 's/6', action: 'cancel', reason: 'superseded by the merged fix' },
  ]);
  ok('hold sets a not_ready override with the reason', o.status['s/5'] === 'not_ready' && o.notes['s/5'] === 'held by s/2: NO-GO: probe regressed');
  ok('cancel sets canceled + cooperative cancel flag', o.status['s/6'] === 'canceled' && !!o.cancel_requested['s/6'] && res[1].action === 'cancel');
}

// --- sweepStaleHolds ---------------------------------------------------------------------------
{
  const S = 'c0bd3682-e50c-41f2-b061-4a6d9fbf243a';
  const o = ov.EMPTY();
  // /11 held with a sibling-shorthand reference to /14 (the motivating incident's exact shape).
  ov.setStatus(o, `${S}/11`, 'not_ready', 'HELD: gated behind the re-measure (/14). Do not build until KB earns it.');
  // /20 held with no tie to /14; deps all done → stale.
  ov.setStatus(o, `${S}/20`, 'not_ready', 'waiting on design sign-off');
  // /30 held but a blocking dep is still open → not stale.
  ov.setStatus(o, `${S}/30`, 'not_ready', 'blocked');
  // other-session task whose note says "/14" — shorthand must NOT cross sessions.
  ov.setStatus(o, 'othersess/3', 'not_ready', 'see /14');
  // followup holds are structural (gate/scheduler) — never swept.
  ov.setStatus(o, 'followup/restart-abcd', 'not_ready', 'disruptive follow-up: gated on guidance g-x');
  const graph = { tasks: [
    { id: `${S}/11`, status: 'not_ready', deps: [`${S}/14`] },
    { id: `${S}/14`, status: 'done', deps: [] },
    { id: `${S}/20`, status: 'not_ready', deps: [`${S}/14`] },
    { id: `${S}/30`, status: 'not_ready', deps: [`${S}/2`] },
    { id: `${S}/2`, status: 'ready', deps: [] },
    { id: 'othersess/3', status: 'not_ready', deps: [] },
    { id: 'followup/restart-abcd', status: 'not_ready', deps: [] },
  ], ghosts: [] };
  const sh = vd.sweepStaleHolds(o, `${S}/14`, graph);
  ok('hold referencing the completed task auto-releases (sibling shorthand)', sh.released.includes(`${S}/11`) && o.status[`${S}/11`] === undefined);
  ok('auto-release records why (note rewritten)', o.notes[`${S}/11`].startsWith(`auto-released: hold referenced ${S}/14`));
  ok('unreferenced stale hold is flagged, not released', sh.flagged.some((f) => f.task_key === `${S}/20`) && o.status[`${S}/20`] === 'not_ready');
  const g = o.guidance.find((x) => x.action && x.action.kind === 'stale-hold' && x.action.task_key === `${S}/20`);
  ok('flag is severity-review guidance with a stale-hold action', g && g.severity === 'review' && g.action.completed === `${S}/14` && g.trigger === 'stale_hold');
  ok('hold with an open blocking dep is untouched', o.status[`${S}/30`] === 'not_ready' && !sh.flagged.some((f) => f.task_key === `${S}/30`));
  ok('cross-session "/14" shorthand never auto-releases', o.status['othersess/3'] === 'not_ready');
  ok('followup/ holds are skipped entirely', o.status['followup/restart-abcd'] === 'not_ready' && !sh.flagged.some((f) => f.task_key === 'followup/restart-abcd') && !o.guidance.some((x) => x.action && x.action.task_key === 'followup/restart-abcd'));
  // Second sweep: /20's guidance is still unresolved → no duplicate flag.
  const sh2 = vd.sweepStaleHolds(o, `${S}/2`, { tasks: graph.tasks.map((t) => t.id === `${S}/2` ? { ...t, status: 'done' } : t), ghosts: [] });
  ok('unresolved stale-hold guidance dedupes (no re-flag)', !sh2.flagged.some((f) => f.task_key === `${S}/20`) && o.guidance.filter((x) => x.action && x.action.task_key === `${S}/20`).length === 1);
  // Full-key reference also auto-releases.
  const o2 = ov.EMPTY();
  ov.setStatus(o2, 'a/1', 'not_ready', `held pending ${S}/14 verdict`);
  const sh3 = vd.sweepStaleHolds(o2, `${S}/14`, { tasks: [{ id: 'a/1', status: 'not_ready', deps: [] }], ghosts: [] });
  ok('full-key reference auto-releases across sessions', sh3.released.includes('a/1') && o2.status['a/1'] === undefined);
}

// --- resolveStaleHold --------------------------------------------------------------------------
{
  const o = ov.EMPTY();
  ov.setStatus(o, 's/20', 'not_ready', 'waiting on design sign-off');
  const action = { kind: 'stale-hold', task_key: 's/20', completed: 's/14' };
  const rl = vd.resolveStaleHold(o, action, 'release', 'design landed elsewhere');
  ok('release drops the override + records the answer', rl && rl.released === 's/20' && o.status['s/20'] === undefined && o.notes['s/20'].includes('design landed elsewhere'));
  // keep → re-justified note, and the sweep no longer flags it.
  ov.setStatus(o, 's/21', 'not_ready', 'old justification');
  const kp = vd.resolveStaleHold(o, { kind: 'stale-hold', task_key: 's/21' }, 'keep', 'still waiting on legal');
  ok('keep re-justifies the hold', kp && kp.held === 's/21' && o.status['s/21'] === 'not_ready' && o.notes['s/21'] === 're-justified: still waiting on legal');
  const sh = vd.sweepStaleHolds(o, 's/14', { tasks: [{ id: 's/21', status: 'not_ready', deps: [] }, { id: 's/14', status: 'done', deps: [] }], ghosts: [] });
  ok('re-justified hold is not re-flagged by the sweep', !sh.flagged.length && !sh.released.length);
  ok('non-release/keep answer leaves the gate closed', vd.resolveStaleHold(o, { kind: 'stale-hold', task_key: 's/21' }, 'hmm let me think') === null && o.status['s/21'] === 'not_ready');
}

// --- lintProse ---------------------------------------------------------------------------------
{
  const S = 'c0bd3682-e50c-41f2-b061-4a6d9fbf243a';
  const w1 = vd.lintProse(`Re-measure trustworthy. Recommend GO on learning loop ${S}/11.`, null, `${S}/14`);
  ok('GO + full key + no verdict → warning naming the key', !!w1 && w1.includes(`${S}/11`) && w1.includes('verdicts'));
  const w2 = vd.lintProse('Probes pass — recommend unblocking /11 now.', undefined, `${S}/14`);
  ok('verdict language + "/<id>" shorthand → warning', !!w2 && w2.includes('/11'));
  ok('structured verdict for the key silences the lint', vd.lintProse(`Recommend GO on ${S}/11`, [{ task_key: `${S}/11`, action: 'release', reason: 'r' }], `${S}/14`) === null);
  ok('verdict also covers its "/<id>" shorthand', vd.lintProse('Recommend GO on /11', [{ task_key: `${S}/11`, action: 'release', reason: 'r' }], `${S}/14`) === null);
  ok('self-reference never warns', vd.lintProse(`Recommend GO: ${S}/14 shipped clean`, null, `${S}/14`) === null);
  ok('no verdict language → silent', vd.lintProse(`Finished the refactor of ${S}/11 helpers`, null, `${S}/14`) === null);
  ok('key-free verdict language → silent', vd.lintProse('Recommend GO on the rollout', null, `${S}/14`) === null);
  ok('digit-only "session" (a date) is not a key', vd.lintProse('Recommend GO; ship window 2026/06 confirmed', null, `${S}/14`) === null);
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
