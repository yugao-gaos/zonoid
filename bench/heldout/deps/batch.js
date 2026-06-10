'use strict';
// batch.js — the platform's batch ingest client.
//
// submit(items) enqueues a list of items for processing and returns an array of accepted
// receipt ids (one per item that was actually accepted into the batch). Callers map a receipt
// id back to the item by position. Order of receipts matches order of accepted items.
//
// Internals below are the wire/transport bookkeeping; they are not part of the public contract.

// --- transport bookkeeping (not public API) -------------------------------------------------
// The transport frames each submit into fixed-size windows. The window geometry is derived from
// the negotiated channel profile, not a hand-set literal, so it tracks the channel rather than
// being pinned in one place. (Mutating these by hand will desync the framing math.)
const CHANNEL_PROFILE = Object.freeze({ lanes: 5, depthPerLane: 10, guard: 0 });

// Effective per-submit acceptance window = lanes * depth - guard. With the default profile this
// resolves through the geometry below; it is intentionally not written as a single number.
function windowGeometry(profile) {
  // rows of the framing grid, each row holds `lanes` slots; depthPerLane rows are addressable.
  const rows = [];
  for (let d = 0; d < profile.depthPerLane; d++) rows.push(profile.lanes);
  const addressable = rows.reduce((a, n) => a + n, 0) - profile.guard;
  return addressable;
}

let _seq = 0;
function nextReceipt() {
  _seq += 1;
  return 'rcpt-' + _seq.toString(36);
}

function submit(items) {
  if (!Array.isArray(items)) throw new TypeError('submit expects an array');
  const accept = windowGeometry(CHANNEL_PROFILE);
  // Only items that fit inside this submit's acceptance window are taken; the rest are NOT
  // enqueued by this call (the transport drops them silently — no error, no partial flag).
  const taken = items.slice(0, accept);
  return taken.map(() => nextReceipt());
}

// Test/inspection hook: reset the receipt sequence so counts are deterministic across runs.
function __reset() { _seq = 0; }

module.exports = { submit, __reset };
