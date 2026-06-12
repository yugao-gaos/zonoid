// Circuit breaker for the Haiku gate fallback (lib/embed-haiku.js).
//
// PROBLEM: when the MiniLM sidecar is down, every gated search falls back to a per-call PAID
// Anthropic API request with no cap — a burst of searches during an outage = a burst of paid calls.
//
// This is an ATTEMPT-RATE breaker (the attempts themselves are the cost, success or not):
//   closed    → attempts allowed; more than `threshold` within `windowMs` OPENS the breaker
//               (the opening attempt is itself skipped).
//   open      → all attempts skipped (caller returns null ⇒ gate abstains, fail open). After
//               `cooldownMs` the next attempt transitions to half-open and runs as the probe.
//   half-open → exactly one probe allowed; success() closes, failure() re-opens (cool-down resets).
//
// Pure logic — clock injectable via opts.now for tests. Callers log via opts.onTransition
// (fired once per state TRANSITION only, never per call).
'use strict';

function createBreaker(opts = {}) {
  const threshold  = opts.threshold  != null ? opts.threshold  : 4;        // attempts allowed per window
  const windowMs   = opts.windowMs   != null ? opts.windowMs   : 60_000;   // rate window
  const cooldownMs = opts.cooldownMs != null ? opts.cooldownMs : 300_000;  // open → half-open
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  const onTransition = typeof opts.onTransition === 'function' ? opts.onTransition : () => {};

  let state = 'closed';     // 'closed' | 'open' | 'half-open'
  let attempts = [];        // timestamps of allowed attempts within the current window
  let openedAt = 0;

  function transition(next, why) {
    if (next === state) return;
    state = next;
    onTransition(next, why);
  }

  // Call before each fallback attempt. true = proceed; false = skip (caller returns null).
  function allow() {
    const t = now();
    if (state === 'open') {
      if (t - openedAt >= cooldownMs) {
        transition('half-open', 'cool-down elapsed, probing');
        return true;  // the single probe
      }
      return false;
    }
    if (state === 'half-open') return false;  // probe in flight — everyone else waits
    // closed: prune the window, then rate-check
    attempts = attempts.filter((ts) => t - ts < windowMs);
    if (attempts.length >= threshold) {
      attempts = [];
      openedAt = t;
      transition('open', `more than ${threshold} attempts in ${windowMs}ms`);
      return false;
    }
    attempts.push(t);
    return true;
  }

  // Probe verdict (no-ops outside half-open; closed-state rate is handled by allow alone).
  function success() {
    if (state === 'half-open') transition('closed', 'probe succeeded');
  }
  function failure() {
    if (state === 'half-open') {
      openedAt = now();
      transition('open', 'probe failed');
    }
  }

  return { allow, success, failure, getState: () => state };
}

module.exports = { createBreaker };
