'use strict';

// Sum a feed of line-item amounts (each rendered as a string) into a grand total.
// Bad rows (missing / empty / unparseable amount) contribute 0 and never throw.
// The total is rounded half-up to 2 decimal places and always returned as a Number.

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;

  for (const row of rows) {
    if (!row || typeof row.amount !== 'string') continue;

    const s = row.amount.trim();
    if (s === '') continue;

    // Optional sign and/or a leading '$' in either order, then a plain decimal.
    const m = s.match(/^([+-])?\s*\$?\s*([+-])?\s*(\d+(?:\.\d+)?)$/);
    if (!m) continue;

    const value = Number(m[3]);
    if (!Number.isFinite(value)) continue;

    const sign = m[1] === '-' || m[2] === '-' ? -1 : 1;
    total += sign * value;
  }

  // Round to cents with a nudge for binary-float representation error.
  const rounded = Math.round((total + Number.EPSILON) * 100) / 100;
  return rounded === 0 ? 0 : rounded; // normalize -0 to 0
}

module.exports = { sumAmounts };
