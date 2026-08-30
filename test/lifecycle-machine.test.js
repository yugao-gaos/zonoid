#!/usr/bin/env node
// Contract tests for the ONE guarded review-lifecycle transition authority
// (lib/overlay/lifecycle-machine.js) and its apply-side wrapper (overlay.applyLifecycleEvent).
//
// Each group pins one of the race/overwrite defects observed live 2026-08-01/02 that motivated the
// module. If one of these regresses, the corresponding real-world failure is back:
//   M1  unknown event is refused, never a silent pass  (destroyed judge queue items)
//   M2  in-flight guard, RETRYABLE                     (terminal verdict on a live worker)
//   M3  worker completion preserves an open request    (review window was inverted)
//   M4  settled verdict is not re-requested/contradicted (lost verdicts)
//   M5  'merged' is absorbing                          (late writer un-merged a merge)
//   M6  retry requeue clears the stale verdict
//   M7  apply wrapper writes only on accept; refusals never mutate
// Run: node test/lifecycle-machine.test.js
'use strict';

const ov = require('../lib/overlay');
const machine = require('../lib/overlay/lifecycle-machine');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const K = 'ws/lifecycle-1';
const NOW = '2026-08-02T00:00:00.000Z';

// --- M1: unknown events are refused loudly -------------------------------------------------------
{
  const o = ov.EMPTY();
  const d = machine.evaluate(o, K, 'review', {});
  ok('M1: unadvertised action "review" is refused, not silently applied', d.ok === false && d.refusal.code === 'unknown_event');
  ok('M1: unknown event is NOT retryable (re-sending would loop)', d.refusal.retryable === false);
  ok('M1: refusal names the legal events', d.refusal.reason.includes('review_approve'));
  ok('M1: unknown event mutates nothing', !o.reviews || !o.reviews[K]);

  const noKey = machine.evaluate(o, '', 'review_approve', {});
  ok('M1: missing task key is refused', noKey.ok === false && noKey.refusal.code === 'missing_key');
}

// --- M2: in-flight guard (the terminal-cancel-on-a-live-worker defect) ---------------------------
for (const status of ['in_progress', 'ready']) {
  for (const event of ['review_approve', 'review_kick_back', 'review_discard', 'review_cancel', 'review_merge_request']) {
    const o = ov.EMPTY();
    o.status[K] = status;
    ov.setReviewLifecycle(o, K, { review_state: 'requested', merge_state: 'review_pending' });
    const d = machine.evaluate(o, K, event, {});
    ok(`M2: ${event} on ${status} is refused`, d.ok === false && d.refusal.code === 'in_flight');
    ok(`M2: ${event} on ${status} is RETRYABLE (item must re-surface, not retire)`, d.refusal.retryable === true);
  }
}
{
  const o = ov.EMPTY();
  o.status[K] = 'in_progress';
  ok('M2: escalate is the one reviewer action legal mid-flight', machine.evaluate(o, K, 'review_escalate', {}).ok === true);
  ok('M2: worker status events are never in-flight-refused', machine.evaluate(o, K, 'status_tested', {}).ok === true);
  ok('M2: merge results are never in-flight-refused', machine.evaluate(o, K, 'merge_landed', {}).ok === true);
  ok('M2: force overrides the in-flight guard', machine.evaluate(o, K, 'review_cancel', { force: true }).ok === true);
  // task_status overrides overlay.status — routes/judge.js reads status off the built graph.
  ok('M2: explicit task_status wins over overlay.status', machine.evaluate(o, K, 'review_approve', { task_status: 'tested' }).ok === true);
  ok('M2: unknown status does NOT block (back-compat for graph-less keys)',
    machine.evaluate(ov.EMPTY(), K, 'review_discard', {}).ok === true);
}

// --- M3: worker completion must not answer a review that was requested for it --------------------
{
  const o = ov.EMPTY();
  ov.applyLifecycleEvent(o, K, 'review_request', { review_requested_by: 'dispatcher', now: NOW });
  ok('M3: prepare opens the request', o.reviews[K].review_state === 'requested' && o.reviews[K].merge_state === 'review_pending');
  const d = ov.applyLifecycleEvent(o, K, 'status_tested', { task_status: 'tested', agent_id: 'worker-a', summary: 'done' });
  ok('M3: worker completing tested does NOT self-approve the open request', d.ok && o.reviews[K].review_state === 'requested');
  ok('M3: merge_state stays review_pending so the drain still sees a candidate', o.reviews[K].merge_state === 'review_pending');
  ok('M3: no verdict is fabricated', !o.reviews[K].review_verdict);
  // The reviewer can then answer it — the window is open AFTER the work exists, not before.
  const a = ov.applyLifecycleEvent(o, K, 'review_approve', { task_status: 'tested', agent_id: 'judge', reason: 'sound', now: NOW });
  ok('M3: reviewer can approve once the task is tested', a.ok && o.reviews[K].review_state === 'approved' && o.reviews[K].merge_state === 'pending');
  ok('M3: approval records reviewer provenance', o.reviews[K].review_agent === 'judge' && o.reviews[K].reviewed_at === NOW);
}
{
  // Compatibility contract: with NO review requested, 'tested' still means approved/awaiting-merge.
  const o = ov.EMPTY();
  ov.applyLifecycleEvent(o, K, 'status_tested', { task_status: 'tested', agent_id: 'worker-a', now: NOW });
  ok('M3: unreviewed tested attempt still self-approves (no-review path unchanged)',
    o.reviews[K].review_state === 'approved' && o.reviews[K].review_verdict === 'APPROVE' && o.reviews[K].merge_state === 'pending');
}

// --- M4: a settled verdict is neither re-requested nor contradicted ------------------------------
{
  const o = ov.EMPTY();
  o.status[K] = 'tested';
  ov.applyLifecycleEvent(o, K, 'review_approve', { task_status: 'tested', agent_id: 'judge', now: NOW });
  const req = ov.applyLifecycleEvent(o, K, 'review_request', { review_requested_by: 'stale-verdict-sweep' });
  ok('M4: stale sweep cannot re-request an approved-awaiting-merge task', req.ok === false && req.refusal.code === 'already_reviewed');
  ok('M4: the landed verdict survives the refused re-request', o.reviews[K].review_state === 'approved' && o.reviews[K].merge_state === 'pending');
  ok('M4: already_reviewed is NOT retryable (item should retire, not loop)', req.refusal.retryable === false);

  const contra = ov.applyLifecycleEvent(o, K, 'review_kick_back', { task_status: 'tested', agent_id: 'judge-2' });
  ok('M4: a contradicting second verdict is refused', contra.ok === false && contra.refusal.code === 'already_reviewed');
  ok('M4: the original verdict is untouched', o.reviews[K].review_verdict === 'APPROVE');

  const again = ov.applyLifecycleEvent(o, K, 'review_approve', { task_status: 'tested', agent_id: 'judge' });
  ok('M4: repeating the SAME verdict is an accepted no-op, not a refusal', again.ok === true && again.noop === true);

  const rework = ov.applyLifecycleEvent(o, K, 'review_request', { rework: true, review_requested_by: 'dispatcher' });
  ok('M4: an explicit rework MAY re-open the review', rework.ok === true && o.reviews[K].review_state === 'requested');
}

// --- M5: 'merged' is absorbing --------------------------------------------------------------------
{
  const base = () => {
    const o = ov.EMPTY();
    o.status[K] = 'tested';
    ov.applyLifecycleEvent(o, K, 'review_approve', { task_status: 'tested', agent_id: 'judge', now: NOW });
    ov.applyLifecycleEvent(o, K, 'merge_landed', { merge_sha: 'abc123', merged_at: NOW });
    return o;
  };
  const merged = base();
  ok('M5: merge_landed records the merge', merged.reviews[K].merge_state === 'merged' && merged.reviews[K].merge_sha === 'abc123');
  ok('M5: merge_landed advances an approved review to landed', merged.reviews[K].review_state === 'landed');

  for (const event of ['review_kick_back', 'review_discard', 'review_cancel', 'review_request', 'merge_conflict', 'merge_failed', 'status_failed', 'retry_requeue']) {
    const o = base();
    const d = ov.applyLifecycleEvent(o, K, event, { task_status: 'tested' });
    ok(`M5: ${event} cannot un-merge a merged attempt`, d.ok === false && d.refusal.code === 'already_merged');
    ok(`M5: ${event} leaves merge_state merged`, o.reviews[K].merge_state === 'merged');
  }
  // git.merged alone (older records with no reviews row) counts as merged too.
  const gitOnly = ov.EMPTY();
  ov.setGit(gitOnly, K, { merged: true, merge_sha: 'def456' });
  ok('M5: a git-only merge record is still absorbing', ov.applyLifecycleEvent(gitOnly, K, 'review_kick_back', { task_status: 'tested' }).refusal.code === 'already_merged');
}

// --- M6: retry requeue clears the verdict that failed the previous attempt -----------------------
{
  const o = ov.EMPTY();
  o.status[K] = 'failed';
  ov.applyLifecycleEvent(o, K, 'status_failed', { task_status: 'failed', agent_id: 'worker', reason: 'no tests', now: NOW });
  ok('M6: failed completion marks the attempt rejected/blocked', o.reviews[K].review_state === 'rejected' && o.reviews[K].merge_state === 'blocked');
  const d = ov.applyLifecycleEvent(o, K, 'retry_requeue', { task_status: 'failed' });
  ok('M6: requeue is accepted', d.ok === true);
  ok('M6: requeue clears the stale verdict so the retry is judged fresh',
    o.reviews[K].review_state === null && o.reviews[K].review_verdict === null && o.reviews[K].merge_state === null);
}

// --- M7: the apply wrapper writes only on accept -------------------------------------------------
{
  const o = ov.EMPTY();
  o.status[K] = 'in_progress';
  const before = JSON.stringify(o.reviews || {});
  const d = ov.applyLifecycleEvent(o, K, 'review_cancel', { reason: 'empty diff' });
  ok('M7: refused transition returns ok:false with a refusal', d.ok === false && !!d.refusal);
  ok('M7: refused transition writes NOTHING', JSON.stringify(o.reviews || {}) === before);
  ok('M7: the decision reports the state it read', d.from.task_status === 'in_progress');

  const accepted = ov.applyLifecycleEvent(o, K, 'review_cancel', { force: true, reason: 'operator override', now: NOW });
  ok('M7: force applies and reports the patch', accepted.ok === true && accepted.patch.review_state === 'canceled');
  ok('M7: forced write lands in the overlay', o.reviews[K].review_state === 'canceled' && o.reviews[K].merge_state === 'closed');
}

// --- status -> event mapping ----------------------------------------------------------------------
{
  ok('status map: tested/failed/done/canceled have events',
    ov.lifecycleEventForStatus('tested') === 'status_tested'
    && ov.lifecycleEventForStatus('failed') === 'status_failed'
    && ov.lifecycleEventForStatus('done') === 'status_done'
    && ov.lifecycleEventForStatus('canceled') === 'status_canceled');
  ok('status map: non-terminal statuses have no lifecycle event',
    ov.lifecycleEventForStatus('in_progress') === null && ov.lifecycleEventForStatus('ready') === null && ov.lifecycleEventForStatus(null) === null);
}

// --- explicit done closes stale pending review state -----------------------------------------------
{
  const o = ov.EMPTY();
  ov.applyLifecycleEvent(o, K, 'review_request', { review_requested_by: 'dispatcher', now: NOW });
  ov.applyLifecycleEvent(o, K, 'status_done', { task_status: 'done', agent_id: 'worker-a' });
  const r = ov.reviewLifecycleFor(o, K, 'done');
  ok('done closes an older pending request', r.review_state === 'landed' && r.review_verdict === 'APPROVE' && r.merge_state === 'closed');
  ok('done preserves request provenance', r.review_requested_by === 'dispatcher' && r.review_requested_at === NOW);
}

// --- stale projected status cannot authorize review on an explicit terminal task ------------------
{
  for (const status of ['done', 'failed', 'canceled']) {
    const o = ov.EMPTY();
    o.status[K] = status;
    ov.setReviewLifecycle(o, K, { review_state: 'requested', merge_state: 'review_pending' });
    const before = JSON.stringify(o.reviews[K]);
    const d = ov.applyLifecycleEvent(o, K, 'review_approve', { task_status: 'tested', agent_id: 'judge' });
    ok(`${status} refuses historical review approval`, d.ok === false && d.refusal.code === 'already_terminal');
    ok(`${status} review refusal writes nothing`, JSON.stringify(o.reviews[K]) === before);
  }
}

// --- raw-patch bridge: legacy hand-built patches map to the SAME guarded events -------------------
{
  const cases = [
    [{ review_state: 'approved', merge_state: 'pending' }, 'review_approve'],
    [{ review_state: 'rejected', merge_state: 'blocked' }, 'review_kick_back'],
    [{ review_state: 'canceled', merge_state: 'closed' }, 'review_cancel'],
    [{ review_state: 'requested', merge_state: 'review_pending' }, 'review_request'],
    [{ review_state: 'landed', merge_state: 'merged' }, 'merge_landed'],
    [{ review_verdict: 'APPROVE' }, 'review_approve'],
    [{ review_verdict: 'KICK_BACK' }, 'review_kick_back'],
    [{ merge_state: 'merged' }, 'merge_landed'],
    [{ merge_state: 'conflict' }, 'merge_conflict'],
    [{ merge_state: 'failed' }, 'merge_failed'],
  ];
  for (const [patch, expected] of cases) {
    ok(`bridge: ${JSON.stringify(patch)} -> ${expected}`, machine.eventForPatch(patch) === expected);
  }
  ok('bridge: bookkeeping-only patches carry no transition',
    machine.eventForPatch({ attempt_branch: 'orch/attempt/x', review_note: 'hi' }) === null
    && machine.hasGuardedFields({ attempt_branch: 'orch/attempt/x' }) === false);
  ok('bridge: an unrecognized state pair maps to NO event (caller must refuse)',
    machine.eventForPatch({ review_state: 'weird_state' }) === null);
  ok('bridge: guarded fields are detected', machine.hasGuardedFields({ merge_state: 'merged' }) === true);
}

console.log(`\n${pass} passed, ${fail} failed`);
if (fail) process.exit(1);
