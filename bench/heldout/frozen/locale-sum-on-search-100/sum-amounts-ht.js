/**
 * KB note (empirical): the upstream billing export mixes en-US dot-decimal ("1,234.56")
 * and de-DE comma-decimal ("1.234,56") in the same feed. Plain parseFloat silently
 * mis-parses comma-decimal values, so we detect the convention per-value via the
 * position of the last separator character before normalizing.
 */

function parseAmount(raw) {
  if (!raw || typeof raw !== 'string') return 0;
  const s = raw.trim();
  if (!s) return 0;

  let rest = s;
  let sign = 1;

  // Extract leading sign (may appear before or after a currency symbol)
  if (rest[0] === '-') { sign = -1; rest = rest.slice(1); }
  else if (rest[0] === '+') { rest = rest.slice(1); }

  // Strip currency symbol / non-numeric prefix (e.g. "$", "€", "£")
  rest = rest.replace(/^[^\d,.-]+/, '');

  // Sign may appear after the symbol (e.g. "$-30.00")
  if (rest[0] === '-') { sign *= -1; rest = rest.slice(1); }
  else if (rest[0] === '+') { rest = rest.slice(1); }

  rest = rest.trim();
  if (!rest) return 0;

  // Detect decimal convention: the last separator character decides.
  //   lastComma > lastDot  →  de-DE: dots = thousands, comma = decimal
  //   otherwise            →  en-US: commas = thousands, dot = decimal
  const lastComma = rest.lastIndexOf(',');
  const lastDot = rest.lastIndexOf('.');

  const normalized =
    lastComma > lastDot
      ? rest.replace(/\./g, '').replace(',', '.')   // de-DE
      : rest.replace(/,/g, '');                      // en-US / plain

  const val = parseFloat(normalized);
  if (!isFinite(val)) return 0;
  return sign * val;
}

function sumAmounts(rows) {
  if (!rows || rows.length === 0) return 0;
  let totalCents = 0;
  for (const row of rows) {
    totalCents += Math.round(parseAmount(row && row.amount) * 100);
  }
  return totalCents / 100;
}

module.exports = { sumAmounts };
