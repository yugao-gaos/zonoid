// ONE authoritative task-review transition authority.
//
// WHY THIS EXISTS. The same-node review lifecycle (overlay.reviews[key] — review_state,
// review_verdict, merge_state, attempt pointers) had NO single writer. Six independent call sites
// each hand-built a patch and blind-merged it through setReviewLifecycle: routes/judge.js
// taskDecision branches, routes/overlay.js status writes, routes/subconscious.js prepare,
// routes/git.js merge results, routes/session.js stale-verdict decisions, and daemon.js sweeps.
// Last writer won, unconditionally, so the state a reader saw depended on arrival order. Observed
// live 2026-08-01/02 (wired as OVERRIDE context notes on the owning task):
//
//   R1 REVIEW-WHILE-LIVE.  prepare stamps review_state 'requested' at DISPATCH time — seconds
//      before the attempt worktree exists. The judge drain offered the item while the worker was
//      still building, saw an attempt branch sitting at the base tip (empty three-dot diff), and
//      applied a terminal cancel to a live task. The worker's own complete was then refused
//      ("task is canceled (terminal)").
//   R2 COMPLETION CLOBBERS THE REQUEST.  The mirror image of R1, and the reason R1 was the ONLY
//      window that ever worked: a worker completing 'tested' ran statusReviewDefaults, which
//      unconditionally stamped review_state 'approved' / merge_state 'pending'. That overwrote the
//      pending 'requested' request, so reviewVerdictPending() went false and the review-verdict
//      drain could never pick the attempt up AFTER the work landed. The review window was exactly
//      inverted: open while the diff was empty, shut once the diff was real.
//   R3 SWEEP RE-REQUESTS A SETTLED VERDICT.  sweepStaleVerdicts guarded only on
//      "already pending"; an approved-awaiting-merge task (review_state 'approved',
//      merge_state 'pending') is not pending, so a stale one got its verdict reset to
//      'requested'/'review_pending' — a landed judgment silently discarded.
//   R4 LATE WRITER UNMERGES A MERGE.  Nothing stopped a kick_back / discard / conflict / re-request
//      arriving after merge_state 'merged' from moving it back to 'blocked'/'closed'/'conflict'.
//   R5 SILENT FALL-THROUGH.  routes/judge.js matched actions with an else-if chain; an unmatched
//      action (e.g. the advertised-but-unimplemented "review") fell off the end, changed NOTHING,
//      and was still permanently stamped into judgedTaskDecisions — destroying the item.
//
// THE FIX. Every transition is a NAMED EVENT evaluated here against the CURRENT state before any
// write happens. evaluate() is pure: it answers with a patch to apply, a noop, or a REFUSAL with a
// machine-readable code — it never mutates. lib/overlay.js#applyLifecycleEvent is the thin
// apply-side wrapper that routes an accepted patch through the existing setReviewLifecycle (so
// field normalization stays in one place too). Callers act on `ok`/`refusal` instead of assuming
// their write landed.
//
// REFUSAL RETRYABILITY is the contract judges depend on. refusal.retryable === true means the
// event was refused because of TIMING (the task is still live) and the item must NOT be retired —
// re-offer it once the task reaches a reviewable status. retryable === false means the event was
// refused because the state is already SETTLED (merged / already judged) or the event is unknown;
// re-offering it would just loop. See routes/judge.js: only non-retryable refusals get stamped.
//
// Pure module — no fs, no require of lib/overlay.js (which requires THIS), no clock beyond an
// injectable opts.now. Keep it that way: the cycle-free direction is overlay.js -> machine.
'use strict';

// Canonical value sets. `null` (no record yet) is a legal review_state/merge_state everywhere.
const REVIEW_STATES = Object.freeze(['requested', 'pending', 'approved', 'rejected', 'landed', 'canceled']);
const MERGE_STATES = Object.freeze(['review_pending', 'pending', 'blocked', 'conflict', 'failed', 'merged', 'closed']);

// A review that has been ASKED FOR but not answered. Mirrors lib/overlay.js#isReviewPendingState and
// lib/headless-drain.js#reviewVerdictPending — the states that make an attempt a drain candidate.
const PENDING_REVIEW_STATES = new Set(['requested', 'pending', 'review_requested', 'review_pending']);
// A review that HAS been answered. Re-requesting or contradicting one of these is a lost verdict.
const SETTLED_REVIEW_STATES = new Set(['approved', 'rejected', 'landed', 'canceled']);

// Task statuses during which the attempt is NOT reviewable: the worker either still holds the claim
// ('in_progress') or has not started ('ready'), so the attempt branch may still sit at base with an
// empty diff. Reviewing here is R1. An unknown/absent status is NOT treated as live — a decision
// item for a task the graph no longer carries stays adjudicable (back-compat).
const LIVE_TASK_STATUSES = new Set(['in_progress', 'ready']);
const TERMINAL_TASK_STATUSES = new Set(['done', 'failed', 'canceled']);

function norm(value) {
  if (value == null) return null;
  const s = String(value).trim().toLowerCase().replace(/[\s-]+/g, '_');
  return s || null;
}

function isReviewPending(value) {
  return PENDING_REVIEW_STATES.has(norm(value));
}

function isReviewSettled(value) {
  return SETTLED_REVIEW_STATES.has(norm(value));
}

function isLiveTaskStatus(value) {
  return LIVE_TASK_STATUSES.has(norm(value));
}

// EVENT TABLE. `actor` drives the in-flight guard: only 'reviewer' events are refused on a live
// task (a worker reporting its OWN completion, or a merge result, is never "too early"). `regresses`
// lists events whose patch would move merge_state off 'merged' — those are refused once merged (R4).
const EVENTS = Object.freeze({
  // --- review request lifecycle -----------------------------------------------------------------
  review_request: { actor: 'system', regresses: true },
  // --- reviewer verdicts (judge drain, api review worker, submit_verdict) ------------------------
  review_approve: { actor: 'reviewer', verdict: 'APPROVE', regresses: true },
  review_kick_back: { actor: 'reviewer', verdict: 'KICK_BACK', regresses: true },
  review_discard: { actor: 'reviewer', verdict: 'DISCARD', regresses: true },
  review_cancel: { actor: 'reviewer', verdict: 'CANCEL', regresses: true },
  // Requests a merge; carries no lifecycle patch of its own (routes/git.js emits merge_landed once
  // the merge actually runs). Still reviewer-gated: merging a live attempt is the silent no-op merge.
  review_merge_request: { actor: 'reviewer', regresses: false },
  // The ONE non-terminal reviewer action — raises a guidance row, settles nothing. Always legal.
  review_escalate: { actor: 'reviewer', regresses: false, alwaysLegal: true },
  // --- worker status writes (POST /overlay/status terminal transitions) --------------------------
  status_tested: { actor: 'worker', regresses: true },
  status_failed: { actor: 'worker', regresses: true },
  status_done: { actor: 'worker', regresses: false },
  status_canceled: { actor: 'worker', regresses: true },
  // --- merge results ----------------------------------------------------------------------------
  merge_landed: { actor: 'merge', regresses: false },
  merge_conflict: { actor: 'merge', regresses: true },
  merge_failed: { actor: 'merge', regresses: true },
  // --- daemon sweeps ----------------------------------------------------------------------------
  retry_requeue: { actor: 'system', regresses: true },
});

const EVENT_NAMES = Object.freeze(Object.keys(EVENTS));

function refuse(code, reason, retryable) {
  return { code, reason, retryable: !!retryable };
}

// Current lifecycle state as the machine sees it. Actual merge evidence and an explicit terminal
// overlay status are authoritative. A graph projection may supply a fresher nonterminal status,
// but stale projected review metadata may never reopen a terminal overlay outcome.
function readState(overlay, key, opts) {
  const rec = (overlay && overlay.reviews && overlay.reviews[key]) || {};
  const git = (overlay && overlay.git && overlay.git[key]) || {};
  const projectedStatus = Object.prototype.hasOwnProperty.call(opts, 'task_status')
    ? norm(opts.task_status)
    : norm(overlay && overlay.status && overlay.status[key]);
  const explicitStatus = norm(overlay && overlay.status && overlay.status[key]);
  const merged = !!git.merged || norm(rec.merge_state) === 'merged';
  const taskStatus = merged
    ? 'done'
    : (TERMINAL_TASK_STATUSES.has(explicitStatus) ? explicitStatus : projectedStatus);
  return {
    review_state: norm(rec.review_state),
    review_verdict: rec.review_verdict ? String(rec.review_verdict).toUpperCase() : null,
    merge_state: norm(rec.merge_state),
    task_status: taskStatus,
    // A merge is landed if EITHER record says so — routes/git.js writes both, older records may
    // carry only the git side.
    merged,
  };
}

function stamp(patch, opts, now) {
  const agent = opts.agent_id || opts.review_agent || null;
  if (agent) patch.review_agent = agent;
  const reason = opts.reason || opts.review_reason || opts.note || opts.summary || null;
  if (reason) {
    patch.review_reason = reason;
    patch.review_note = opts.note || opts.review_note || reason;
  }
  if (now) patch.reviewed_at = now;
  return patch;
}

// The patch an event WANTS to write, before guards. Returns null for events that carry no lifecycle
// patch (escalate / merge_request) — those settle other state (guidance rows, counters) elsewhere.
function patchFor(event, from, opts, now) {
  switch (event) {
    case 'review_request': {
      const patch = {
        review_state: 'requested',
        merge_state: 'review_pending',
        review_requested_at: opts.review_requested_at || now,
      };
      if (opts.review_requested_by || opts.requested_by) {
        patch.review_requested_by = opts.review_requested_by || opts.requested_by;
      }
      if (opts.legacy_judge_task_key) patch.legacy_judge_task_key = opts.legacy_judge_task_key;
      const note = opts.note || opts.review_note || opts.reason || opts.review_reason;
      if (note) { patch.review_note = opts.note || opts.review_note || note; patch.review_reason = opts.reason || opts.review_reason || note; }
      return patch;
    }
    case 'review_approve':
      return stamp({ review_state: 'approved', review_verdict: 'APPROVE', merge_state: 'pending' }, opts, now);
    case 'review_kick_back':
      return stamp({ review_state: 'rejected', review_verdict: 'KICK_BACK', merge_state: 'blocked' }, opts, now);
    case 'review_discard':
    case 'review_cancel':
      return stamp({ review_state: 'canceled', merge_state: 'closed' }, opts, now);
    case 'review_merge_request':
    case 'review_escalate':
      return null;

    // R2: a worker completing its own attempt must NOT answer a review that was asked for. Preserve
    // the pending request (and the merge_state that keeps it a drain candidate) so the review window
    // OPENS on completion instead of closing. Only an unreviewed attempt self-approves on 'tested',
    // which is the long-standing compatibility contract for the no-review path.
    case 'status_tested':
      if (isReviewPending(from.review_state) || from.merge_state === 'review_pending') {
        return stamp({ review_state: 'requested', merge_state: 'review_pending' }, { note: opts.note, summary: opts.summary, agent_id: opts.agent_id }, null);
      }
      return stamp({ review_state: 'approved', review_verdict: 'APPROVE', merge_state: 'pending' }, opts, now);
    case 'status_failed':
      return stamp({ review_state: 'rejected', review_verdict: 'KICK_BACK', merge_state: 'blocked' }, opts, now);
    case 'status_done':
      return stamp({
        review_state: 'landed',
        review_verdict: 'APPROVE',
        merge_state: from.merged ? 'merged' : 'closed',
      }, opts, opts.reviewed_at || now);
    case 'status_canceled':
      return stamp({ review_state: 'canceled', review_verdict: null, merge_state: from.merged ? 'merged' : 'closed' }, opts, now);

    case 'merge_landed': {
      const patch = { merge_state: 'merged', merged_at: opts.merged_at || now };
      if (opts.merge_sha) patch.merge_sha = opts.merge_sha;
      // Advance an open/approved review to 'landed'; never rewrite a rejection or a cancel — those
      // are history, and a merge on top of them is a separate anomaly worth keeping visible.
      if (isReviewPending(from.review_state) || from.review_state === 'approved' || from.review_state == null) {
        patch.review_state = 'landed';
        patch.review_verdict = from.review_verdict || 'APPROVE';
      }
      return patch;
    }
    case 'merge_conflict':
      return { merge_state: 'conflict', review_reason: opts.reason || null, review_note: opts.note || opts.reason || null };
    case 'merge_failed':
      return { merge_state: 'failed' };

    // The attempt is going back into the ready pipeline, so the verdict that failed it is no longer
    // about the work that will exist. Clear it rather than leaving a 'rejected' record on a task the
    // dashboard is showing as pending.
    case 'retry_requeue':
      return {
        review_state: null,
        review_verdict: null,
        merge_state: null,
        reviewed_at: null,
        review_agent: null,
      };
    default:
      return null;
  }
}

// Does this event's outcome already hold? A repeated identical verdict is a legal no-op, not a
// conflict — drains retry, and a retry must not read as a refusal.
function isNoop(event, from, patch) {
  if (!patch) return true;
  // NEVER a no-op: a repeated request carries fresh provenance (requested_by/at, the legacy judge
  // key) that a no-op would drop on the floor. Re-stamping an already-open request is harmless.
  if (event === 'review_request') return false;
  const wantsReview = Object.prototype.hasOwnProperty.call(patch, 'review_state') ? norm(patch.review_state) : null;
  const wantsMerge = Object.prototype.hasOwnProperty.call(patch, 'merge_state') ? norm(patch.merge_state) : null;
  if (wantsReview == null && wantsMerge == null) return false;
  return (wantsReview == null || wantsReview === from.review_state)
    && (wantsMerge == null || wantsMerge === from.merge_state);
}

/**
 * Decide a lifecycle transition. PURE — inspects `overlay`, mutates nothing.
 *
 * @param overlay  the workspace overlay (reads .reviews, .git, .status)
 * @param key      task key
 * @param event    one of EVENT_NAMES
 * @param opts     { now?, task_status?, agent_id?, reason?/note?/summary?, force?, rework?,
 *                   merge_sha?, merged_at?, review_requested_by?, legacy_judge_task_key?, ... }
 * @returns {{ok, event, key, noop, patch, refusal, from}}
 *          ok:false + refusal -> DO NOT WRITE. refusal.retryable tells a judge whether to re-offer
 *          the item (timing) or retire it (already settled / unknown event).
 */
function evaluate(overlay, key, event, opts = {}) {
  const name = typeof event === 'string' ? event.trim() : '';
  const from = readState(overlay, key, opts);
  const base = { ok: false, event: name || null, key, noop: false, patch: null, refusal: null, from };

  const spec = EVENTS[name];
  // R5: an unknown event is an ERROR, not a silent pass. Never retryable — re-sending the same
  // unknown name would loop forever.
  if (!spec) {
    return { ...base, refusal: refuse('unknown_event', `unknown lifecycle event '${event}'; expected one of ${EVENT_NAMES.join(', ')}`, false) };
  }
  if (!key) {
    return { ...base, refusal: refuse('missing_key', 'lifecycle transition requires a task key', false) };
  }

  // R1: reviewer verdicts are refused while the worker still owns the attempt. RETRYABLE — the
  // attempt becomes reviewable the moment the worker completes, so the item must survive.
  if (spec.actor === 'reviewer' && !spec.alwaysLegal && !opts.force && isLiveTaskStatus(from.task_status)) {
    return { ...base, refusal: refuse('in_flight', `task is ${from.task_status}: the worker still owns the attempt, so its diff is not final`, true) };
  }

  // R4: 'merged' is absorbing. Nothing that would move merge_state off it is allowed through.
  if (from.merged && spec.regresses && !opts.force) {
    return { ...base, refusal: refuse('already_merged', 'attempt is already merged; merge_state is terminal', false) };
  }

  // A terminal task status is also absorbing for historical reviewer actions. In particular, a
  // late review_approve must not turn done+review_pending into approved+merge-pending and enqueue a
  // merge for an attempt that the task lifecycle already closed. Actual merge evidence is checked
  // first above because landed remains the strongest terminal fact.
  if (spec.actor === 'reviewer' && !spec.alwaysLegal && !opts.force && TERMINAL_TASK_STATUSES.has(from.task_status)) {
    return { ...base, refusal: refuse('already_terminal', `task is already terminal as '${from.task_status}'`, false) };
  }

  const now = opts.now || new Date().toISOString();
  const patch = patchFor(name, from, opts, now);

  // R3: never re-open or contradict a verdict that already landed. `rework` (an explicit re-attempt)
  // is the sanctioned way to re-request; `force` is the escape hatch for operators.
  if (name === 'review_request' && isReviewSettled(from.review_state) && !opts.rework && !opts.force) {
    return { ...base, refusal: refuse('already_reviewed', `review already settled as '${from.review_state}'; pass rework to re-open`, false) };
  }
  if (spec.verdict && isReviewSettled(from.review_state) && !opts.force) {
    const same = norm(patch && patch.review_state) === from.review_state;
    if (!same) {
      return { ...base, refusal: refuse('already_reviewed', `review already settled as '${from.review_state}'; a contradicting verdict would discard it`, false) };
    }
  }

  if (isNoop(name, from, patch)) {
    return { ...base, ok: true, noop: true, patch: null };
  }
  return { ...base, ok: true, patch };
}

// Fields a raw patch may carry that MEAN a transition (as opposed to bookkeeping like attempt
// pointers or request provenance, which no guard needs to see).
const GUARDED_FIELDS = Object.freeze(['review_state', 'review_verdict', 'merge_state']);

function hasGuardedFields(patch) {
  if (!patch || typeof patch !== 'object') return false;
  return GUARDED_FIELDS.some((f) => Object.prototype.hasOwnProperty.call(patch, f) && patch[f] != null);
}

/**
 * Back-compat bridge: infer the EVENT a hand-built review patch is trying to express, so legacy raw
 * writers (POST /overlay/status with a `review` object or top-level review fields) get the same
 * guards as a named event. Returns null when the patch's guarded fields describe no known
 * transition — the caller should refuse rather than write, because an unrecognized state pair is
 * exactly the kind of blind merge this module exists to stop.
 */
function eventForPatch(patch) {
  if (!hasGuardedFields(patch)) return null;
  const rs = norm(patch.review_state);
  const rv = patch.review_verdict ? norm(patch.review_verdict).toUpperCase() : null;
  const ms = norm(patch.merge_state);
  // review_state is the primary signal; merge_state only disambiguates when it is absent.
  if (rs === 'approved') return 'review_approve';
  if (rs === 'rejected') return 'review_kick_back';
  if (rs === 'canceled') return 'review_cancel';
  if (rs === 'landed') return ms === 'merged' ? 'merge_landed' : 'status_done';
  if (rs === 'requested' || rs === 'pending') return 'review_request';
  if (rs) return null;
  if (rv === 'APPROVE' || rv === 'APPROVED') return 'review_approve';
  if (rv === 'KICK_BACK' || rv === 'REJECT' || rv === 'REJECTED') return 'review_kick_back';
  if (ms === 'merged') return 'merge_landed';
  if (ms === 'conflict') return 'merge_conflict';
  if (ms === 'failed') return 'merge_failed';
  if (ms === 'blocked') return 'review_kick_back';
  if (ms === 'pending') return 'review_approve';
  if (ms === 'review_pending') return 'review_request';
  if (ms === 'closed') return 'status_done';
  return null;
}

module.exports = {
  EVENTS,
  EVENT_NAMES,
  GUARDED_FIELDS,
  eventForPatch,
  hasGuardedFields,
  REVIEW_STATES,
  MERGE_STATES,
  LIVE_TASK_STATUSES,
  PENDING_REVIEW_STATES,
  SETTLED_REVIEW_STATES,
  evaluate,
  isLiveTaskStatus,
  isReviewPending,
  isReviewSettled,
};
