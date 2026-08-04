'use strict';

// Token estimation for the search-economy retrieval bench.
//
// Default estimator is chars/4 — the standard rough heuristic, good enough to
// COMPARE arms (the absolute number doesn't matter, the cross-arm ratio does).
// If a real tokenizer is ever added to the repo we prefer it transparently:
//   - @xenova/transformers (already an optionalDependency) exposes AutoTokenizer.
//     We do NOT hard-depend on it (it's optional and heavy); if it's installed
//     AND a caller opts in via { tokenizer: <fn> } we use that instead.
//
// Public API:
//   estimateTokens(text)            -> number   (chars/4, floored, min 0)
//   countTokens(text, opts?)        -> number   (uses opts.tokenizer if given, else estimateTokens)
//   makeCounter(opts?)              -> (text)=>number   bound counter for a run

const CHARS_PER_TOKEN = 4;

function estimateTokens(text) {
  const s = text == null ? '' : String(text);
  if (!s.length) return 0;
  return Math.ceil(s.length / CHARS_PER_TOKEN);
}

// opts.tokenizer: optional (text) => number | number[] (token ids). If provided we
// trust it; otherwise fall back to the chars/4 estimate. Kept dependency-free so
// `node run.js` works on a bare checkout with no install step.
function countTokens(text, opts = {}) {
  const tok = opts && opts.tokenizer;
  if (typeof tok === 'function') {
    try {
      const out = tok(text == null ? '' : String(text));
      if (typeof out === 'number' && Number.isFinite(out)) return out;
      if (Array.isArray(out)) return out.length;
    } catch {
      // fall through to estimate on any tokenizer failure
    }
  }
  return estimateTokens(text);
}

function makeCounter(opts = {}) {
  return (text) => countTokens(text, opts);
}

module.exports = { estimateTokens, countTokens, makeCounter, CHARS_PER_TOKEN };
