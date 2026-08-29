'use strict';
/**
 * The three cadence knobs below are resolved PER PUMP through lib/tuning (env > tuning.json >
 * default), not frozen at runner construction. That is what makes them hot-reloadable: a
 * POST /config/tuning (or a hand-edit of tuning.json) changes the delay the very next time
 * nextDelay() runs, with no daemon restart. They used to be module-load consts, which is why
 * retuning the drain cadence cost a restart.
 */
const tuning = require('./tuning');

const FAIRNESS_LANES = new Set(['maintenance', 'frontier']);
// Sibling runners have independent timers; a handoff must be able to shorten the target idle timer.
const fairnessWakeups = new WeakMap();

function otherLane(lane) {
  return lane === 'maintenance' ? 'frontier' : 'maintenance';
}

function createHeadlessDrainRunner({ headlessDrain, state, getState, lane = null }) {
  if (!headlessDrain) throw new Error('headlessDrain is required');
  const readState = typeof getState === 'function' ? getState : () => state;
  const fairnessLane = FAIRNESS_LANES.has(lane) ? lane : null;
  const governor = headlessDrain._governor || null;
  const registerDetachedCompletionListener = typeof headlessDrain._setDetachedCompletionListener === 'function'
    ? headlessDrain._setDetachedCompletionListener.bind(headlessDrain)
    : null;

  // Jitter stays FIXED per runner (its job is to de-sync sibling daemons/pumps from each other);
  // only the base is re-resolved, so a live retune does not also reshuffle the offset every tick.
  const idleJitterMs = Math.floor(Math.random() * 60 * 1000);
  const idlePollMs = () => tuning.get('idle_poll_ms') + idleJitterMs;
  const continuousDelayMs = () => tuning.get('continuous_delay_ms');
  const retryDelayMs = () => tuning.get('retry_delay_ms');

  let headlessDrainTimer = null;
  let headlessDrainNextAt = 0;
  let headlessDrainRunning = false;
  let headlessDrainWakePending = false;
  let fairnessWake = null;
  let releaseDetachedCompletionListener = null;

  function schedule(delayMs, reason) {
    const delay = Math.max(0, Number(delayMs) || 0);
    if (headlessDrainRunning) {
      headlessDrainWakePending = true;
      return;
    }
    const nextAt = Date.now() + delay;
    if (headlessDrainTimer && headlessDrainNextAt <= nextAt) return;
    if (headlessDrainTimer) clearTimeout(headlessDrainTimer);
    headlessDrainNextAt = nextAt;
    headlessDrainTimer = setTimeout(() => runPump(reason), delay);
    if (headlessDrainTimer && typeof headlessDrainTimer.unref === 'function') headlessDrainTimer.unref();
  }

  function nextDelay(result) {
    const backoffUntil = headlessDrain._governor && headlessDrain._governor.backoffUntil;
    if (backoffUntil && Date.now() < backoffUntil) {
      return Math.max(retryDelayMs(), backoffUntil - Date.now());
    }
    if (result && result.ran > 0) return continuousDelayMs();
    if (result && result.skipped === 'backoff') {
      return backoffUntil && Date.now() < backoffUntil
        ? Math.max(retryDelayMs(), backoffUntil - Date.now())
        : retryDelayMs();
    }
    if (result && (
      result.skipped === 'concurrency_cap'
      || result.skipped === 'global_concurrency_cap'
      || result.skipped === 'global_lease_lock_busy'
      || result.skipped === 'label_in_progress'
      || result.skipped === 'fairness_handoff'
    )) {
      return retryDelayMs();
    }
    return idlePollMs();
  }

  // Both daemon pumps share one governor but have independent timers. A failing learner used to
  // win the first timer race after every backoff, immediately recreate the backoff, and prevent the
  // Frontier spawn pump from ever observing an open slot. When one lane CREATES a backoff, reserve
  // a short, bounded post-backoff window for the other lane. The window starts only after the real
  // throttle deadline, so it cannot bypass provider backoff; it expires after two retry cadences so
  // a disabled/idle opposite lane cannot permanently starve maintenance.
  function shouldYieldFairnessTurn(nowMs) {
    if (!fairnessLane || !governor) return false;
    const turn = governor.postBackoffFairness;
    if (!turn || !FAIRNESS_LANES.has(turn.lane)) return false;
    if (nowMs < Number(governor.backoffUntil || 0)) return false;
    if (nowMs >= Number(turn.expiresAt || 0)) {
      delete governor.postBackoffFairness;
      return false;
    }
    if (turn.lane === fairnessLane) {
      delete governor.postBackoffFairness;
      return false;
    }
    return true;
  }

  function handOffAfterNewBackoff(previousUntil, nowMs, transitionBackoffUntil = null) {
    if (!fairnessLane || !governor) return;
    const currentUntil = Number(governor.backoffUntil || 0);
    const nextUntil = transitionBackoffUntil === null
      ? currentUntil
      : Number(transitionBackoffUntil || 0);
    // Detached jobs settle out of order. Their captured deadline identifies the transition they
    // created; once the governor has moved on, that notice may wake polling but must not overwrite
    // the newer transition's fairness owner/provenance.
    if (transitionBackoffUntil !== null && nextUntil !== currentUntil) return;
    if (nextUntil <= nowMs || nextUntil === Number(previousUntil || 0)) return;
    governor.postBackoffFairness = {
      lane: otherLane(fairnessLane),
      createdBy: fairnessLane,
      backoffUntil: nextUntil,
      expiresAt: nextUntil + Math.max(1000, retryDelayMs() * 2),
    };
    const lanes = fairnessWakeups.get(governor);
    const wake = lanes && lanes.get(otherLane(fairnessLane));
    if (wake) wake(Math.max(0, nextUntil - Date.now()));
  }

  function detachedCompletion(outcome = {}) {
    const completedAt = Date.now();
    if (outcome.newBackoff) {
      handOffAfterNewBackoff(outcome.previousBackoffUntil, completedAt, outcome.backoffUntil);
    }
    const backoffUntil = Number(governor && governor.backoffUntil || 0);
    schedule(backoffUntil > completedAt ? backoffUntil - completedAt : 0, 'detached-completion');
  }

  async function runPump(reason) {
    headlessDrainTimer = null;
    headlessDrainNextAt = 0;
    if (headlessDrainRunning) {
      headlessDrainWakePending = true;
      return { ran: 0, skipped: 'runner_busy', drains: [] };
    }
    headlessDrainRunning = true;
    let result = null;
    const startedAt = Date.now();
    const previousBackoffUntil = governor ? Number(governor.backoffUntil || 0) : 0;
    try {
      if (governor && startedAt < Number(governor.backoffUntil || 0)) {
        result = { ran: 0, skipped: 'backoff', drains: [] };
      } else if (shouldYieldFairnessTurn(startedAt)) {
        result = {
          ran: 0,
          skipped: 'fairness_handoff',
          drains: [],
          fairness_lane: fairnessLane,
          fairness_to: governor.postBackoffFairness.lane,
        };
      } else {
        result = await headlessDrain.runDueDrains(readState());
      }
    } catch (e) {
      result = { ran: 0, skipped: 'error', error: e && e.message ? e.message : String(e) };
    } finally {
      headlessDrainRunning = false;
    }
    if (result && result.skipped !== 'fairness_handoff') {
      handOffAfterNewBackoff(previousBackoffUntil, Date.now());
    }
    if (headlessDrainWakePending) {
      headlessDrainWakePending = false;
      const hardPause = result && [
        'backoff',
        'fairness_handoff',
        'iterations_exhausted',
        'token_budget_exhausted',
        'no_backend',
      ].includes(result.skipped);
      schedule(hardPause ? nextDelay(result) : continuousDelayMs(), 'pending-change');
      return result;
    }
    schedule(nextDelay(result), result && result.skipped ? result.skipped : 'drained');
    return result;
  }

  function stop() {
    if (headlessDrainTimer) clearTimeout(headlessDrainTimer);
    headlessDrainTimer = null;
    headlessDrainNextAt = 0;
    headlessDrainWakePending = false;
    if (releaseDetachedCompletionListener) {
      releaseDetachedCompletionListener();
      releaseDetachedCompletionListener = null;
    }
    const lanes = governor && fairnessWakeups.get(governor);
    if (lanes && lanes.get(fairnessLane) === fairnessWake) {
      lanes.delete(fairnessLane);
      if (!lanes.size) fairnessWakeups.delete(governor);
    }
  }

  if (fairnessLane && governor) {
    fairnessWake = (delayMs) => schedule(delayMs, 'fairness-handoff');
    let lanes = fairnessWakeups.get(governor);
    if (!lanes) {
      lanes = new Map();
      fairnessWakeups.set(governor, lanes);
    }
    lanes.set(fairnessLane, fairnessWake);
  }
  if (registerDetachedCompletionListener) {
    const release = registerDetachedCompletionListener(detachedCompletion);
    if (typeof release === 'function') releaseDetachedCompletionListener = release;
  }

  return {
    schedule,
    requestWake: () => schedule(0, 'graph-change'),
    // Test seam: lets the hot-reload test observe that a cadence retune lands on THIS live runner
    // (no reconstruction, i.e. no daemon restart).
    _nextDelay: nextDelay,
    // Deterministic scheduler seams. Production uses schedule/requestWake; tests call the same
    // pump directly so backoff races do not require minute-long wall-clock sleeps.
    _runPump: runPump,
    _stop: stop,
  };
}

module.exports = { createHeadlessDrainRunner };
