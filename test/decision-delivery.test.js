#!/usr/bin/env node
'use strict';

const delivery = require('../lib/decision-delivery');
const overlay = require('../lib/overlay');

let pass = 0;
let fail = 0;
function ok(label, condition) {
  if (condition) { pass++; console.log(`PASS  ${label}`); }
  else { fail++; console.error(`FAIL  ${label}`); }
}

const T0 = Date.parse('2026-07-22T18:00:00.000Z');
const live = (workspace, at = T0) => ({ workspace, lastSeen: new Date(at).toISOString() });
const graph = (...tasks) => ({ tasks });

// Exclusive assignment honors the requesting/origin session and never broadcasts.
{
  const o = overlay.EMPTY();
  o.status.origin = 'in_progress';
  o.claimSessions.origin = 'session-b';
  const id = overlay.addGuidance(o, {
    question: 'Choose a migration path', severity: 'blocking', origin_task: 'origin', request_session: 'session-b',
  });
  const sessions = { 'session-a': live('/ws'), 'session-b': live('/ws') };
  delivery.assignLeases(o, sessions, graph({ id: 'origin', status: 'in_progress', session: 'session-b' }), '/ws', { nowMs: T0 });
  const item = o.guidance.find((g) => g.id === id);
  ok('exclusive lease assigned to relevant session', item.delivery.session_id === 'session-b');
  ok('other live session receives no prompt', delivery.takeDueNudges(o, 'session-a', sessions, graph(), '/ws', { nowMs: T0 }).length === 0);
}

// Explicit close and TTL expiry both permit deterministic takeover.
{
  const o = overlay.EMPTY();
  const id = overlay.addGuidance(o, { question: 'Proceed?', severity: 'blocking', request_session: 'session-a' });
  const sessions = { 'session-a': live('/ws'), 'session-b': live('/ws', T0 - 1000) };
  delivery.assignLeases(o, sessions, graph(), '/ws', { nowMs: T0, leaseMs: 1000 });
  sessions['session-a'].closedAt = new Date(T0 + 100).toISOString();
  delivery.assignLeases(o, sessions, graph(), '/ws', { nowMs: T0 + 100 });
  ok('closed session lease is taken over', o.guidance.find((g) => g.id === id).delivery.session_id === 'session-b');

  sessions['session-a'] = live('/ws', T0 + 3000);
  sessions['session-b'].lastSeen = new Date(T0 - 20000).toISOString();
  delivery.assignLeases(o, sessions, graph(), '/ws', { nowMs: T0 + 3000, leaseMs: 1000, sessionTtlMs: 10000 });
  ok('expired lease and session are reclaimed', o.guidance.find((g) => g.id === id).delivery.session_id === 'session-a');
}

// Prompt delivery is deduplicated and reminder backoff is persisted on the guidance row.
{
  const o = overlay.EMPTY();
  overlay.addGuidance(o, { question: 'Pick one', severity: 'blocking', request_session: 's' });
  const sessions = { s: live('/ws') };
  const opts = { nowMs: T0, reminderBaseMs: 1000, reminderMaxMs: 8000 };
  ok('first due prompt is delivered once', delivery.takeDueNudges(o, 's', sessions, graph(), '/ws', opts).length === 1);
  ok('immediate poll does not duplicate prompt', delivery.takeDueNudges(o, 's', sessions, graph(), '/ws', opts).length === 0);
  ok('prompt remains backed off before deadline', delivery.takeDueNudges(o, 's', sessions, graph(), '/ws', { ...opts, nowMs: T0 + 999 }).length === 0);
  ok('prompt reappears at persisted deadline', delivery.takeDueNudges(o, 's', sessions, graph(), '/ws', { ...opts, nowMs: T0 + 1000 }).length === 1);
  ok('backoff doubles after reminder', Date.parse(o.guidance[0].delivery.next_prompt_at) === T0 + 3000);
}

// Staleness uses explicit structural facts only. Ambiguous relevance remains pending.
{
  const o = overlay.EMPTY();
  o.status.done = 'done';
  const stale = overlay.addGuidance(o, { question: 'Still needed?', severity: 'blocking', origin_task: 'done' });
  const ambiguous = overlay.addGuidance(o, { question: 'Unbound legacy question', severity: 'blocking' });
  const removed = overlay.addGuidance(o, { question: 'Task vanished?', severity: 'blocking', origin_task: 'missing' });
  const ids = delivery.reconcileStale(o, T0, graph({ id: 'done', status: 'done' }));
  ok('terminal objective is deterministically stale', ids.includes(stale) && o.guidance.find((g) => g.id === stale).decision_state === 'stale');
  ok('unbound semantic ambiguity remains pending', !o.guidance.find((g) => g.id === ambiguous).resolved);
  ok('missing objective is not silently deleted', !o.guidance.find((g) => g.id === removed).resolved);
}

// Guidance delivery is informational: it never creates a task execution hold, and touching an old
// overlay clears legacy decision_holds left by the previous implementation.
{
  const o = overlay.EMPTY();
  o.decision_holds.origin = { guidance_id: 'legacy', at: new Date(T0).toISOString() };
  overlay.addGuidance(o, { question: 'Need input', severity: 'blocking', origin_task: 'origin' });
  ok('origin receives no decision hold', !o.decision_holds.origin);
  ok('legacy decision holds are cleared', Object.keys(o.decision_holds).length === 0);
}

// Workspace-wide resolution is idempotent: the first answer and timestamp cannot be overwritten.
{
  const o = overlay.EMPTY();
  const id = overlay.addGuidance(o, { question: 'Race?', severity: 'blocking', origin_task: 'origin' });
  const first = delivery.resolveFirst(o, id, 'first', T0);
  const second = delivery.resolveFirst(o, id, 'second', T0 + 1);
  const item = o.guidance.find((g) => g.id === id);
  ok('first resolver wins', first.first === true && second.first === false);
  ok('later answer cannot overwrite winner', item.answer === 'first' && item.resolvedAt === new Date(T0).toISOString());
}

// Legacy rows normalize lazily without losing their original fields.
{
  const o = overlay.EMPTY();
  o.guidance.push({ id: 'legacy', question: 'Old row', severity: 'blocking', ts: new Date(T0).toISOString(), resolved: false });
  delivery.assignLeases(o, { s: live('/ws') }, graph(), '/ws', { nowMs: T0 });
  ok('legacy guidance lazily gains delivery state', o.guidance[0].decision_state === 'pending' && !!o.guidance[0].delivery);
  ok('legacy guidance content is preserved', o.guidance[0].question === 'Old row');
}

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail ? 1 : 0);
