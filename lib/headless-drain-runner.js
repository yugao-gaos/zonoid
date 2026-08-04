'use strict';
/**
 * The three cadence knobs below are resolved PER PUMP through lib/tuning (env > tuning.json >
 * default), not frozen at runner construction. That is what makes them hot-reloadable: a
 * POST /config/tuning (or a hand-edit of tuning.json) changes the delay the very next time
 * nextDelay() runs, with no daemon restart. They used to be module-load consts, which is why
 * retuning the drain cadence cost a restart.
 */
const tuning = require('./tuning');

function createHeadlessDrainRunner({ headlessDrain, state, getState }) {
  if (!headlessDrain) throw new Error('headlessDrain is required');
  const readState = typeof getState === 'function' ? getState : () => state;

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
    )) {
      return retryDelayMs();
    }
    return idlePollMs();
  }

  async function runPump(reason) {
    headlessDrainTimer = null;
    headlessDrainNextAt = 0;
    if (headlessDrainRunning) {
      headlessDrainWakePending = true;
      return;
    }
    headlessDrainRunning = true;
    let result = null;
    try {
      result = await headlessDrain.runDueDrains(readState());
    } catch (e) {
      result = { ran: 0, skipped: 'error', error: e && e.message ? e.message : String(e) };
    } finally {
      headlessDrainRunning = false;
    }
    if (headlessDrainWakePending) {
      headlessDrainWakePending = false;
      const hardPause = result && [
        'backoff',
        'iterations_exhausted',
        'token_budget_exhausted',
        'no_backend',
      ].includes(result.skipped);
      schedule(hardPause ? nextDelay(result) : continuousDelayMs(), 'pending-change');
      return;
    }
    schedule(nextDelay(result), result && result.skipped ? result.skipped : 'drained');
  }

  return {
    schedule,
    requestWake: () => schedule(0, 'graph-change'),
    // Test seam: lets the hot-reload test observe that a cadence retune lands on THIS live runner
    // (no reconstruction, i.e. no daemon restart).
    _nextDelay: nextDelay,
  };
}

module.exports = { createHeadlessDrainRunner };
