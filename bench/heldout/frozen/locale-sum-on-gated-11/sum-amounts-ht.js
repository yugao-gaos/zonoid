'use strict';

// Resolve the role of a single separator char (`.` or `,`) in a numeric string:
// thousands grouping vs. decimal point. Returns a JS-normalized string (dot decimal).
function resolveSingle(s, sep) {
  const parts = s.split(sep);
  // More than one occurrence => grouping separator (e.g. "1.234.567"). Strip all.
  if (parts.length > 2) return parts.join('');
  const before = parts[0];
  const after = parts[1];
  // Single separator with exactly 3 trailing digits and a 1-3 digit head
  // (e.g. "1,234" / "1.234") is a thousands group, not a decimal.
  if (after.length === 3 && before.length >= 1 && before.length <= 3) {
    return before + after;
  }
  // Otherwise it's the decimal point.
  return sep === ',' ? before + '.' + after : s;
}

// Normalize an en-US ("1,234.56") or de-DE ("1.234,56" / "99,90") numeric body
// into a plain JS number literal (dot as decimal, no grouping).
function normalizeNumeric(s) {
  const hasDot = s.indexOf('.') !== -1;
  const hasComma = s.indexOf(',') !== -1;
  if (hasDot && hasComma) {
    // The right-most separator is the decimal point; the other is grouping.
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      return s.replace(/\./g, '').replace(/,/g, '.');
    }
    return s.replace(/,/g, '');
  }
  if (hasComma) return resolveSingle(s, ',');
  if (hasDot) return resolveSingle(s, '.');
  return s;
}

// Parse one amount field to a Number, or return null if it is not a parseable
// monetary value (caller treats null as a contribution of 0).
function parseAmount(raw) {
  if (typeof raw === 'number') return isFinite(raw) ? raw : null;
  if (typeof raw !== 'string') return null;

  let s = raw.trim();
  if (s === '') return null;

  // Strip a currency symbol (may sit before or after the sign).
  s = s.replace(/\$/g, '').trim();

  let sign = 1;
  if (s[0] === '-') { sign = -1; s = s.slice(1).trim(); }
  else if (s[0] === '+') { s = s.slice(1).trim(); }

  // After stripping symbol/sign, only digits and separators may remain.
  if (s === '' || !/^[0-9.,]+$/.test(s)) return null;

  const n = Number(normalizeNumeric(s));
  if (!isFinite(n)) return null;
  return sign * n;
}

// Sum a feed of line items, each carrying a string `amount`. Bad/missing rows
// contribute 0. Returns a Number rounded half-up to 2 decimals (0 for [] ).
function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const amount = parseAmount(row.amount);
    if (amount !== null) total += amount;
  }

  // Round half-up at the cent; the EPSILON nudge absorbs binary float drift
  // (e.g. 0.1 + 0.2) so exact cent totals land cleanly.
  const cents = Math.round((total + (total >= 0 ? 1 : -1) * Number.EPSILON * Math.abs(total)) * 100);
  const result = cents / 100;
  return result === 0 ? 0 : result; // normalize -0 to 0
}

module.exports = { sumAmounts };
