'use strict';

// sumAmounts — total a feed of money line items.
//
// Each row carries `amount` as a STRING (the upstream export serializes money
// as text, never a JSON number). The feed mixes locales: amounts may use the
// en-US convention (dot decimal, comma thousands: "1,234.56") OR the de-DE
// convention (comma decimal, dot thousands: "1.234,56"). A naive
// parseFloat()/Number() silently truncates the de-DE rows ("99,90" -> 99), so
// we normalize the separators by locale before summing.

// Parse one amount string into a Number, or NaN if it is not a parseable
// monetary value (so the caller can skip the row without poisoning the total).
function parseAmount(raw) {
  if (typeof raw !== 'string') return NaN;

  let s = raw.trim();
  if (s === '') return NaN;

  // Strip a leading currency symbol and/or sign, in either order ($-, -$, -, $).
  let sign = 1;
  const lead = s.match(/^([+-]?)\s*\$?\s*([+-]?)\s*/);
  if (lead && lead[0] !== '') {
    if (lead[1] === '-') sign = -sign;
    if (lead[2] === '-') sign = -sign;
    s = s.slice(lead[0].length);
  }

  // Whatever remains must be digits plus grouping/decimal marks only.
  if (!/^[0-9.,]+$/.test(s) || !/[0-9]/.test(s)) return NaN;

  const hasDot = s.indexOf('.') !== -1;
  const hasComma = s.indexOf(',') !== -1;

  if (hasDot && hasComma) {
    // Both present: the separator appearing LAST is the decimal mark; the
    // other groups thousands. Handles "1,234.56" and "1.234,56" alike.
    const decSep = s.lastIndexOf('.') > s.lastIndexOf(',') ? '.' : ',';
    const thoSep = decSep === '.' ? ',' : '.';
    s = s.split(thoSep).join('');
    s = s.replace(decSep, '.');
  } else if (hasComma) {
    // Comma only. en-US thousands ("1,234") vs de-DE decimal ("99,90").
    const single = s.indexOf(',') === s.lastIndexOf(',');
    const after = s.slice(s.lastIndexOf(',') + 1);
    if (!single || after.length === 3) {
      s = s.split(',').join(''); // thousands grouping
    } else {
      s = s.replace(',', '.'); // decimal mark
    }
  } else if (hasDot) {
    // Dot only. A single dot is the en-US decimal mark (the spec's canonical
    // form); multiple dots can only be de-DE thousands grouping.
    const single = s.indexOf('.') === s.lastIndexOf('.');
    if (!single) {
      s = s.split('.').join('');
    }
  }

  const n = Number(s);
  return Number.isFinite(n) ? sign * n : NaN;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = parseAmount(row.amount);
    if (Number.isFinite(value)) total += value;
  }

  // Round the grand total to 2 decimals (half-up at the cent); the EPSILON
  // nudge absorbs binary-float drift so e.g. 0.1 + 0.2 rounds cleanly.
  const rounded = Math.round((total + Number.EPSILON) * 100) / 100;
  return rounded === 0 ? 0 : rounded; // normalize -0 to 0
}

module.exports = { sumAmounts };
