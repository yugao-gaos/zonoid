'use strict';
// promotion.js — generic shadow→enforce AUTO-PROMOTE comparator.
//
// Mirrors the edge-clf agreement-rate promotion gate (bench-economy.js / edge-clf mode.json+config):
// a learned model runs in SHADOW until it provably beats the incumbent over a STABLE WINDOW, then the
// live decision source flips automatically — no manual step. This module is the reusable comparator;
// the ask-gate is its first consumer (edge-clf could adopt it later — hence the generic shape).
//
// CONTRACT
//   samples : array of { challenger, incumbent } accuracy pairs, oldest→newest (e.g. one per training
//             cycle, read off metrics.jsonl). Higher = better.
//   opts.window  : how many most-recent samples must exist AND all clear the bar (stability). Default 3.
//   opts.margin  : challenger must beat incumbent by at least this on EVERY sample in the window.
//                  Default 0.02. The margin guards against flips on noise / a single lucky cycle.
//
// evaluate() returns { promote, reason, window, nSamples, lastChallenger, lastIncumbent }.
// promote=true ⇒ caller flips the live source incumbent→challenger. It NEVER flips back here (a
// monotone latch — demotion, if ever wanted, is a separate explicit decision), matching the
// "promote to primary only after it proves out" one-way arc of the shadow→enforce rollout.

const DEFAULTS = { window: 3, margin: 0.02 };

function evaluate(samples, opts = {}) {
  const window = opts.window != null ? opts.window : DEFAULTS.window;
  const margin = opts.margin != null ? opts.margin : DEFAULTS.margin;
  const rows = Array.isArray(samples) ? samples.filter(
    (s) => s && typeof s.challenger === 'number' && typeof s.incumbent === 'number') : [];

  if (rows.length < window) {
    return { promote: false, reason: 'insufficient-window', window, nSamples: rows.length,
      lastChallenger: null, lastIncumbent: null };
  }
  const recent = rows.slice(-window);
  const last = recent[recent.length - 1];
  // STABILITY: the challenger must beat the incumbent by `margin` on EVERY sample in the window.
  const allBeat = recent.every((s) => s.challenger - s.incumbent >= margin);
  return {
    promote: allBeat,
    reason: allBeat ? 'challenger-beats-incumbent' : 'not-stable-margin',
    window, nSamples: rows.length,
    lastChallenger: last.challenger, lastIncumbent: last.incumbent,
  };
}

module.exports = { evaluate, DEFAULTS };
