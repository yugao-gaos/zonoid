'use strict';

// Sum a feed of line-item amounts (serialized as strings) into a grand total.
//
// The upstream export does NOT use a single locale: most rows are en-US
// (dot decimal, e.g. "1234.56", "$19.95"), but a large fraction are de-DE /
// European (comma decimal, dot thousands: "1.234,56" === 1234.56, "99,90" ===
// 99.90, "2.500,00" === 2500). A naive Number()/parseFloat after stripping the
// currency symbol mis-sums this feed: Number("1.234,56") is NaN (row dropped,
// total too low) and parseFloat("99,90") is 99 (cents truncated). So each
// amount is locale-normalized to a canonical "intpart.frac" before Number().

// Normalize a cleaned numeric token (digits plus '.' and ',' separators) into a
// plain JS-parseable decimal string. The separator whose LAST occurrence is
// rightmost is the decimal point; every other separator is a thousands grouping
// and is stripped.
function normalizeDecimal(token) {
  const lastDot = token.lastIndexOf('.');
  const lastComma = token.lastIndexOf(',');

  if (lastDot === -1 && lastComma === -1) return token;

  let decimalSep;
  if (lastDot === -1) decimalSep = ',';
  else if (lastComma === -1) decimalSep = '.';
  else decimalSep = lastDot > lastComma ? '.' : ',';

  const decimalIdx = token.lastIndexOf(decimalSep);
  const intPart = token.slice(0, decimalIdx).replace(/[.,]/g, '');
  const fracPart = token.slice(decimalIdx + 1).replace(/[.,]/g, '');
  return intPart + '.' + fracPart;
}

// Parse one row's amount into a Number, or null if it is missing / unparseable
// (such a row contributes 0 to the total — it must never throw or yield NaN).
function parseAmount(raw) {
  if (typeof raw !== 'string') return null;

  // Strip whitespace and the (informational) currency symbol; sign may appear
  // on either side of the symbol, so handle it after removing '$'.
  let t = raw.replace(/\s/g, '').replace(/\$/g, '');

  let sign = 1;
  if (t[0] === '-') { sign = -1; t = t.slice(1); }
  else if (t[0] === '+') { t = t.slice(1); }

  // After sign/symbol removal a valid amount is only digits and separators,
  // and must contain at least one digit.
  if (!/^[0-9.,]+$/.test(t) || !/[0-9]/.test(t)) return null;

  const value = Number(normalizeDecimal(t));
  if (!Number.isFinite(value)) return null;

  return sign * value;
}

// Round a total to 2 decimals, half-up by magnitude (so refunds round the same
// way as charges). The small epsilon nudge absorbs binary-float drift so values
// that are mathematically on the half-cent boundary round up rather than down.
function roundCents(n) {
  if (!Number.isFinite(n)) return 0;
  const sign = n < 0 ? -1 : 1;
  const rounded = Math.round(Math.abs(n) * 100 + 1e-6) / 100;
  return sign * rounded;
}

function sumAmounts(rows) {
  if (!Array.isArray(rows)) return 0;

  let total = 0;
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue;
    const value = parseAmount(row.amount);
    if (value !== null) total += value;
  }

  return roundCents(total);
}

module.exports = { sumAmounts };
