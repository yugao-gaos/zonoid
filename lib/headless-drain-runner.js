'use strict';

function createHeadlessDrainRunner({ headlessDrain, state, getState }) {
  if (!headlessDrain) throw new Error('headlessDrain is required');
  const readState = typeof getState === 'function' ? getState : () => state;

  const HEADLESS_DRAIN_IDLE_POLL_MS =
    (Number(process.env.HEADLESS_DRAIN_IDLE_POLL_MS)
      || Number(process.env.HEADLESS_DRAIN_INTERVAL_MS)
      || 2 * 60 * 1000)
    + Math.floor(Math.random() * 60 * 1000);
  const HEADLESS_DRAIN_CONTINUOUS_DELAY_MS =
    Number(process.env.HEADLESS_DRAIN_CONTINUOUS_DELAY_MS) || 15000;
  const HEADLESS_DRAIN_RETRY_DELAY_MS =
    Number(process.env.HEADLESS_DRAIN_RETRY_DELAY_MS) || 5000;

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
      return Math.max(HEADLESS_DRAIN_RETRY_DELAY_MS, backoffUntil - Date.now());
    }
    if (result && result.ran > 0) return HEADLESS_DRAIN_CONTINUOUS_DELAY_MS;
    if (result && result.skipped === 'backoff') {
      return backoffUntil && Date.now() < backoffUntil
        ? Math.max(HEADLESS_DRAIN_RETRY_DELAY_MS, backoffUntil - Date.now())
        : HEADLESS_DRAIN_RETRY_DELAY_MS;
    }
    if (result && (
      result.skipped === 'concurrency_cap'
      || result.skipped === 'global_concurrency_cap'
      || result.skipped === 'global_lease_lock_busy'
      || result.skipped === 'label_in_progress'
    )) {
      return HEADLESS_DRAIN_RETRY_DELAY_MS;
    }
    return HEADLESS_DRAIN_IDLE_POLL_MS;
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
      schedule(hardPause ? nextDelay(result) : HEADLESS_DRAIN_CONTINUOUS_DELAY_MS, 'pending-change');
      return;
    }
    schedule(nextDelay(result), result && result.skipped ? result.skipped : 'drained');
  }

  return {
    schedule,
    requestWake: () => schedule(0, 'graph-change'),
  };
}

module.exports = { createHeadlessDrainRunner };
