'use strict';

// Parse a single amount string into integer cents.
// Returns null if the value is missing/empty/not a clean monetary string.
function parseCents(raw) {
  if (typeof raw !== 'string') return null;

  const trimmed = raw.trim();
  if (trimmed === '') return null;

  // Strip a single leading currency symbol; sign may sit on either side of it.
  const cleaned = trimmed.replace('$', '');

  // Accept an optional sign followed by digits with an optional fractional part.
  if (!/^[-+]?\d+(\.\d+)?$/.test(cleaned)) return null;

  const value = Number(cleaned);
  if (!Number.isFinite(value)) return null;

  // Work in integer cents to avoid float drift when summing.
  return Math.round(value * 100);
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let totalCents = 0;
  for (const row of rows) {
    const cents = parseCents(row && row.amount);
    if (cents !== null) totalCents += cents;
  }

  return totalCents / 100;
}

module.exports = { sumAmounts };
