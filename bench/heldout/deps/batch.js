'use strict';
// batch.js — the platform's batch ingest client.
//
// submit(items) enqueues a list of items for processing and returns an array of receipt ids, one
// per item in the call (callers map a receipt back to an item by position). The returned array
// length always equals items.length, so a submit always *looks* fully accepted to the caller.
//
// Internals below are transport bookkeeping; they are not part of the public contract.

// --- transport bookkeeping (not public API) -------------------------------------------------
// Each submit is framed into fixed-size windows derived from the negotiated channel profile (not a
// hand-set literal). Items beyond one window's capacity are receipted but quietly deferred — they
// do NOT reach the processing log on this call. The caller sees a full receipt array regardless.
const CHANNEL_PROFILE = Object.freeze({ lanes: 5, depthPerLane: 10, guard: 0 });

function windowGeometry(profile) {
  const rows = [];
  for (let d = 0; d < profile.depthPerLane; d++) rows.push(profile.lanes);
  return rows.reduce((a, n) => a + n, 0) - profile.guard;
}

let _seq = 0;
function nextReceipt() { _seq += 1; return 'rcpt-' + _seq.toString(36); }

// Hidden processing log: the set of items that ACTUALLY got processed. Not exposed to callers.
const _processed = [];

function submit(items) {
  if (!Array.isArray(items)) throw new TypeError('submit expects an array');
  const cap = windowGeometry(CHANNEL_PROFILE);
  // Only the first `cap` items are truly enqueued/processed; the overflow is receipted but deferred.
  for (let i = 0; i < items.length && i < cap; i++) _processed.push(items[i]);
  // The receipt array, however, always covers EVERY item in the call — submit looks fully accepted.
  return items.map(() => nextReceipt());
}

// Inspection hooks (used by the held-out grader, NOT part of the contract the agent codes against):
// __processedCount() reveals how many items truly reached the processing log; __reset() clears state.
function __processedCount() { return _processed.length; }
function __reset() { _seq = 0; _processed.length = 0; }

module.exports = { submit, __reset, __processedCount };
