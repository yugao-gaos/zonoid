'use strict';
/**
 * llm-grader.js — the LLM search-loop GRADER for the agentic context-search loop.
 *
 * WHAT THIS IS
 * ------------
 * `runAgenticContextSearches` (lib/subconscious/index.js) drives a multi-round retrieval loop: each
 * round runs a search, ranks/filters candidates by cheap lexical+structural heuristics
 * (rankResults / filterAgenticContextResults / evidenceQualityForResult), and decides whether to
 * continue with a deterministic stop rule. Those heuristics are blunt — a high-cosine candidate that
 * is topically adjacent but IRRELEVANT to the searcher's actual intent still scores well, and the
 * next-query reformulation is mechanical (it staples the top result's title/summary onto the query).
 *
 * This module is the LLM-graded alternative to that per-round decision. Given the searcher's INTENT,
 * the original query, the evidence gathered so far, and this round's candidate results, an LLM
 * decides, in ONE structured call:
 *   (a) continue — whether another search round is warranted,
 *   (b) nextQuery — the reformulated query derived from the intent + what's been found (null on stop),
 *   (c) kept      — which candidates are genuinely relevant to the INTENT (vs high-cosine-but-off),
 *   (d) abstain   — or, that NOTHING cleared the relevance bar (kept stays empty),
 *   (e) aggregate — a synthesized, searcher-facing summary of the relevant evidence.
 *
 * SCOPE (this task — MODULE + TESTS ONLY):
 *   This is a STANDALONE module. It is NOT wired into runAgenticContextSearches — that integration is
 *   a separate downstream task. Nothing here imports or mutates the search loop; it only exports
 *   gradeSearchRound + the backend adapter so the loop (later) and the unit tests (now) can drive it.
 *
 * BACKEND (dependency-injected)
 * -----------------------------
 * The LLM call is injected as `backend` so tests mock it with zero network. A backend is any object
 * exposing an async `complete({ prompt, system })  -> { text }` (or a bare string). The DEFAULT
 * backend (createDefaultGraderBackend) wraps the SAME provider seam the judge uses
 * (lib/llm-backend.getActiveBackend(overlay) → provider.callApi for kind:'api', or a spawned
 * agentic-cli provider) so the dashboard backend selection + automode config are shared, not forked.
 */

const DEFAULT_MAX_CANDIDATES = 24;     // cap candidates serialized into the prompt (latency/token bound)
const DEFAULT_MAX_EVIDENCE = 12;       // cap prior-evidence items serialized into the prompt
const SUMMARY_CHAR_CAP = 320;          // per-field summary truncation in the serialized payload
const AGGREGATE_CHAR_CAP = 2000;       // hard cap on the synthesized aggregate we return

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function clampInt(value, lo, hi, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(lo, Math.min(hi, Math.floor(n)));
}

function truncate(value, max) {
  const s = cleanString(value);
  return s.length > max ? s.slice(0, max) : s;
}

/**
 * Resolve a stable candidate KEY from a candidate/result object. The search loop's compactResult uses
 * `key`; we also tolerate `task_key`/`id` so a caller passing raw graph nodes still keys correctly.
 */
function candidateKey(candidate) {
  if (!candidate || typeof candidate !== 'object') return '';
  return cleanString(candidate.key || candidate.task_key || candidate.id);
}

/**
 * Project a candidate into the compact, token-bounded shape we hand the LLM. Mirrors the fields the
 * search loop's compactResult/rankResults already attach (key, title, summary, kind, tier, score,
 * rank_score, lexical_score) so the grader reasons over the same surface the heuristic loop produces,
 * without the full node payload.
 */
function projectCandidate(candidate) {
  const key = candidateKey(candidate);
  const out = {
    key,
    title: truncate(candidate.title || candidate.label || key, 160),
    summary: truncate(candidate.summary, SUMMARY_CHAR_CAP),
  };
  if (candidate.kind != null) out.kind = candidate.kind;
  if (candidate.tier != null) out.tier = candidate.tier;
  for (const f of ['score', 'rank_score', 'lexical_score', 'evidence_quality', 'weight']) {
    const v = Number(candidate[f]);
    if (Number.isFinite(v)) out[f] = Number(v.toFixed(3));
  }
  return out;
}

/**
 * Normalize evidenceSoFar (whatever the caller accumulated) into compact {key,title,summary} items.
 * Accepts an array of result-shaped objects; strings are wrapped as free-text evidence. Null/empty in,
 * empty array out.
 */
function projectEvidence(evidenceSoFar) {
  if (evidenceSoFar == null) return [];
  const arr = Array.isArray(evidenceSoFar) ? evidenceSoFar : [evidenceSoFar];
  const out = [];
  for (const item of arr) {
    if (item == null) continue;
    if (typeof item === 'string') {
      const text = truncate(item, SUMMARY_CHAR_CAP);
      if (text) out.push({ text });
      continue;
    }
    if (typeof item !== 'object') continue;
    const key = candidateKey(item);
    const entry = {
      key: key || undefined,
      title: truncate(item.title || item.label || key, 160) || undefined,
      summary: truncate(item.summary || item.text, SUMMARY_CHAR_CAP) || undefined,
    };
    if (entry.key || entry.title || entry.summary) out.push(entry);
  }
  return out;
}

const GRADER_SYSTEM_PROMPT = [
  'You are the search-loop grader for an agentic context-retrieval system. A searcher is running',
  'multiple retrieval rounds to gather context for a stated INTENT. Each round produces candidate',
  'results ranked by cosine/lexical similarity. Similarity is NECESSARY BUT NOT SUFFICIENT: a',
  'candidate can be highly similar yet irrelevant to the actual intent. Your job, for THIS round, is',
  'to decide — strictly and conservatively — what is genuinely relevant and whether to keep searching.',
  '',
  'Return STRICT JSON ONLY (no prose, no code fence) of EXACTLY this shape:',
  '{',
  '  "continue": <boolean>,            // true iff another search round is warranted',
  '  "nextQuery": <string|null>,       // reformulated query from intent + findings; null when continue is false',
  '  "kept": [<candidate key>, ...],   // keys of candidates RELEVANT to the intent (drop high-cosine-but-off-topic)',
  '  "abstain": <boolean>,             // true iff NOTHING cleared the relevance bar (kept MUST be empty)',
  '  "aggregate": <string>             // synthesized, searcher-facing summary of the relevant evidence',
  '}',
  '',
  'Rules: keep ONLY candidates relevant to the intent — prefer dropping a doubtful candidate over',
  'keeping it. If you abstain, "kept" must be []. If "continue" is false, "nextQuery" must be null.',
  'Never invent candidate keys: every key in "kept" MUST appear verbatim in the provided candidates.',
].join('\n');

/**
 * Build the user-message payload for the grader call. Compact + bounded: the intent, original query,
 * round budget, projected prior evidence, and projected candidates as JSON the model grades.
 */
function buildGraderPayload(input, limits) {
  const candidates = (Array.isArray(input.candidates) ? input.candidates : [])
    .map(projectCandidate)
    .filter((c) => c.key)
    .slice(0, limits.maxCandidates);
  const evidence = projectEvidence(input.evidenceSoFar).slice(0, limits.maxEvidence);
  return {
    payload: {
      intent: cleanString(input.intent),
      original_query: cleanString(input.originalQuery),
      round: limits.round,
      max_rounds: limits.maxRounds,
      rounds_remaining: Math.max(0, limits.maxRounds - limits.round),
      evidence_so_far: evidence,
      candidates,
    },
    candidateKeys: new Set(candidates.map((c) => c.key)),
  };
}

function buildGraderPrompt(payloadObj) {
  return [
    'Grade this search round. Decide continue/nextQuery/kept/abstain/aggregate per the rules.',
    '',
    JSON.stringify(payloadObj, null, 2),
  ].join('\n');
}

/**
 * Extract the grader JSON object from raw model text. Tolerant of a leading/trailing code fence or
 * surrounding prose: grabs the first balanced-looking {...} span and JSON-parses it. Returns the
 * parsed object, or null on any failure (caller falls back to conservative defaults).
 */
function extractJson(text) {
  const s = cleanString(text);
  if (!s) return null;
  // Fast path: the whole reply is a JSON object.
  if (s[0] === '{' && s[s.length - 1] === '}') {
    try { return JSON.parse(s); } catch { /* fall through to span scan */ }
  }
  // Strip a ```json … ``` fence if present.
  const fence = s.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence && fence[1]) {
    const inner = fence[1].trim();
    try { return JSON.parse(inner); } catch { /* fall through */ }
  }
  // Span scan: first '{' to last '}'.
  const first = s.indexOf('{');
  const last = s.lastIndexOf('}');
  if (first !== -1 && last > first) {
    const span = s.slice(first, last + 1);
    try { return JSON.parse(span); } catch { return null; }
  }
  return null;
}

/** The conservative fallback verdict used on parse failure or a backend error: stop, keep nothing. */
function fallbackResult(reason) {
  return {
    continue: false,
    nextQuery: null,
    kept: [],
    abstain: true,
    aggregate: '',
    parsed: false,
    fallback_reason: reason || 'parse_failure',
  };
}

/**
 * Coerce a parsed grader object into the strict result contract, enforcing every invariant so a
 * sloppy-but-parseable model reply can't violate the shape downstream consumers rely on:
 *   - kept is filtered to keys that actually appeared in the candidates (no invented keys), deduped;
 *   - abstain ⇒ kept forced empty;  kept non-empty ⇒ abstain forced false;
 *   - continue is a strict boolean;  continue false ⇒ nextQuery null;
 *   - continue true with a blank nextQuery degrades to no continuation (can't continue with no query);
 *   - aggregate is a bounded string.
 */
function coerceResult(parsed, candidateKeys) {
  if (!parsed || typeof parsed !== 'object') return fallbackResult('not_an_object');

  let cont = parsed.continue === true;
  let nextQuery = cleanString(parsed.nextQuery) || null;

  const rawKept = Array.isArray(parsed.kept) ? parsed.kept : [];
  const seen = new Set();
  const kept = [];
  for (const k of rawKept) {
    const key = cleanString(k);
    if (!key || seen.has(key)) continue;
    if (!candidateKeys.has(key)) continue;   // never honor an invented key
    seen.add(key);
    kept.push(key);
  }

  // abstain reconciliation: explicit abstain empties kept; non-empty kept overrides a stray abstain.
  let abstain = parsed.abstain === true;
  if (abstain) kept.length = 0;
  if (kept.length > 0) abstain = false;
  if (kept.length === 0) abstain = true; // no relevant candidate kept == abstain, regardless of flag

  // continue/nextQuery reconciliation.
  if (!cont) nextQuery = null;
  if (cont && !nextQuery) cont = false; // can't run another round without a query

  const aggregate = truncate(parsed.aggregate, AGGREGATE_CHAR_CAP);

  return { continue: cont, nextQuery, kept, abstain, aggregate, parsed: true };
}

/**
 * Invoke the injected backend with the grader system+user prompt and return the raw text reply.
 * Accepts the few shapes a backend might expose so a test mock can be a one-liner:
 *   - a function:                         backend(prompt, system) -> string | { text }
 *   - { complete(args) }                  args = { prompt, system }; -> string | { text }
 *   - { grade(args) }                     alias of complete
 * Returns the text string, or throws (caught by the caller → fallback).
 */
async function callBackend(backend, prompt, system) {
  if (!backend) throw new Error('llm-grader: backend is required');
  let raw;
  if (typeof backend === 'function') {
    raw = await backend({ prompt, system });
  } else if (typeof backend.complete === 'function') {
    raw = await backend.complete({ prompt, system });
  } else if (typeof backend.grade === 'function') {
    raw = await backend.grade({ prompt, system });
  } else {
    throw new Error('llm-grader: backend must be a function or expose complete()/grade()');
  }
  if (raw == null) return '';
  if (typeof raw === 'string') return raw;
  if (typeof raw.text === 'string') return raw.text;
  if (typeof raw.result === 'string') return raw.result;   // claude/codex provider parseResult shape
  if (raw.message && typeof raw.message.content === 'string') return raw.message.content; // chat shape
  return '';
}

/**
 * Grade ONE search round.
 *
 * @param {object} input
 *   @param {string} input.intent        — the searcher's stated intent (what they actually want).
 *   @param {string} input.originalQuery — the original (round-1) query string.
 *   @param {Array|string} [input.evidenceSoFar] — evidence accumulated across prior rounds (result-
 *                                          shaped objects and/or free-text strings).
 *   @param {Array} input.candidates     — THIS round's candidate results (compactResult-shaped:
 *                                          { key, title, summary, kind?, tier?, score?, rank_score?, ... }).
 *   @param {number} [input.round]       — 1-based current round index.
 *   @param {number} [input.maxRounds]   — round budget.
 * @param {object} deps
 *   @param {Function|object} deps.backend — injected LLM backend (see callBackend); REQUIRED.
 *   @param {number} [deps.maxCandidates]  — cap candidates serialized (default DEFAULT_MAX_CANDIDATES).
 *   @param {number} [deps.maxEvidence]    — cap prior-evidence items serialized (default DEFAULT_MAX_EVIDENCE).
 * @returns {Promise<{continue:boolean, nextQuery:(string|null), kept:string[], abstain:boolean,
 *                     aggregate:string, parsed:boolean, fallback_reason?:string}>}
 *          On a backend error or unparseable reply, resolves the conservative fallback (stop, abstain,
 *          keep nothing) with parsed:false — it NEVER throws.
 */
async function gradeSearchRound(input = {}, deps = {}) {
  const backend = deps.backend;
  const limits = {
    round: clampInt(input.round, 1, 1000, 1),
    maxRounds: clampInt(input.maxRounds, 1, 1000, 1),
    maxCandidates: clampInt(deps.maxCandidates, 1, 200, DEFAULT_MAX_CANDIDATES),
    maxEvidence: clampInt(deps.maxEvidence, 0, 200, DEFAULT_MAX_EVIDENCE),
  };
  if (limits.maxRounds < limits.round) limits.maxRounds = limits.round;

  const { payload, candidateKeys } = buildGraderPayload(input, limits);
  const prompt = buildGraderPrompt(payload);

  let text;
  try {
    text = await callBackend(backend, prompt, GRADER_SYSTEM_PROMPT);
  } catch (err) {
    return fallbackResult(`backend_error: ${err && err.message ? err.message : String(err)}`);
  }

  const parsed = extractJson(text);
  if (!parsed) return fallbackResult('parse_failure');
  return coerceResult(parsed, candidateKeys);
}

/**
 * Build the DEFAULT grader backend over the shared provider seam (lib/llm-backend). Returns a
 * `{ complete({prompt, system}) -> { text } }` object that drives the dashboard-selected backend:
 *   - kind:'api'         → provider.callApi({ messages, model, key }) IN-PROCESS (Node https, no child).
 *   - kind:'agentic-cli' → NOT a single-call seam (the agentic providers self-drive a loop), so for
 *                          the in-process grader we require an api-kind backend. An agentic-cli active
 *                          backend throws here, telling the caller to inject an explicit backend (the
 *                          grader is a single structured call, not an agent loop).
 *
 * @param {object} [opts]
 *   @param {object} [opts.overlay]      — workspace overlay (read for config.backend); defaults to {}.
 *   @param {object} [opts.backendLib]   — injectable lib/llm-backend (tests); defaults to the real one.
 *   @param {number} [opts.maxTokens]    — max_tokens for the completion (default 1024).
 * @returns {{ complete: (args:{prompt:string, system?:string}) => Promise<{text:string}> }}
 */
function createDefaultGraderBackend(opts = {}) {
  const backendLib = opts.backendLib || require('../llm-backend');
  const overlay = opts.overlay || {};
  return {
    async complete({ prompt, system } = {}) {
      const active = backendLib.getActiveBackend(overlay);
      const provider = active && active.provider;
      if (!provider) throw new Error('llm-grader default backend: no active provider');
      if (provider.kind !== 'api' || typeof provider.callApi !== 'function') {
        throw new Error(
          `llm-grader default backend: active provider "${active.providerId}" is kind "${provider.kind}"; ` +
          'the in-process grader needs an api-kind backend (callApi). Inject an explicit backend for agentic-cli.'
        );
      }
      const messages = [];
      if (system) messages.push({ role: 'system', content: system });
      messages.push({ role: 'user', content: String(prompt || '') });
      const out = await provider.callApi({
        messages,
        model: active.model,
        key: active.config && active.config.key,
        maxTokens: opts.maxTokens || 1024,
      });
      return { text: (out && typeof out.text === 'string') ? out.text : '' };
    },
  };
}

module.exports = {
  gradeSearchRound,
  createDefaultGraderBackend,
  // exported for direct use + unit tests
  GRADER_SYSTEM_PROMPT,
  buildGraderPayload,
  buildGraderPrompt,
  extractJson,
  coerceResult,
  projectCandidate,
  projectEvidence,
  fallbackResult,
};
