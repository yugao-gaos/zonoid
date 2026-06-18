'use strict';
const fs = require('fs');
const path = require('path');

// Estimated cost per avoided Sonnet judge call.
// Typical judge call: ~2000 input tokens + ~300 output tokens with Sonnet 3.5.
// At $3/MTok input + $15/MTok output: (2000/1e6)*3 + (300/1e6)*15 = $0.006 + $0.0045 = ~$0.0105.
const SONNET_COST_PER_CALL_USD = 0.011;

/**
 * Count rows in .graph/gate-labeled.jsonl where by === 'model'.
 * Returns {avoided, total_verdicts, fraction}.
 * Never throws — returns zeros if file missing/empty.
 *
 * @param {string} ws - workspace root path
 * @returns {{ avoided: number, total_verdicts: number, fraction: number }}
 */
function callsAvoided(ws) {
  const zero = { avoided: 0, total_verdicts: 0, fraction: 0 };
  try {
    const file = path.join(ws, '.graph', 'gate-labeled.jsonl');
    let raw;
    try {
      raw = fs.readFileSync(file, 'utf8');
    } catch {
      return zero;
    }

    const lines = raw.split('\n').filter(Boolean);
    if (lines.length === 0) return zero;

    let total_verdicts = 0;
    let avoided = 0;

    for (const line of lines) {
      let row;
      try { row = JSON.parse(line); } catch { continue; }
      if (row && typeof row.by === 'string') {
        total_verdicts++;
        if (row.by === 'model') avoided++;
      }
    }

    if (total_verdicts === 0) return zero;

    return {
      avoided,
      total_verdicts,
      fraction: avoided / total_verdicts,
    };
  } catch {
    return zero;
  }
}

/**
 * Compute estimated savings from avoided Sonnet judge calls.
 *
 * @param {string} ws - workspace root path
 * @returns {{ avoided, total_verdicts, fraction, estimated_cost_usd, cost_per_call_usd, note }}
 */
function estimatedSavings(ws) {
  const result = callsAvoided(ws);
  return {
    ...result,
    estimated_cost_usd: result.avoided * SONNET_COST_PER_CALL_USD,
    cost_per_call_usd: SONNET_COST_PER_CALL_USD,
    note: 'estimated',
  };
}

module.exports = { callsAvoided, estimatedSavings, SONNET_COST_PER_CALL_USD };
