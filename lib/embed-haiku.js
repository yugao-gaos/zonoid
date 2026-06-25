// Haiku gate fallback — used when MiniLM sidecar is unavailable (loading / disabled).
//
// Instead of cosine similarity, asks claude-haiku-4-5 to judge whether any of the top-N
// note summaries are relevant enough to inject into the task context. Returns the same
// shape as gateTask so the daemon can swap it in transparently.
//
// This fires rarely in steady state (only during the sidecar's ~30s startup window on
// first boot, and never on subsequent daemon restarts). It is a safety net, not the
// primary path.
'use strict';
const https = require('https');
const { createBreaker } = require('./haiku-breaker');

const MODEL      = 'claude-haiku-4-5-20251001';
const MAX_NOTES  = 5;    // send top-N notes by lexical score; keeps the prompt small
const TIMEOUT_MS = 8000;

// Circuit breaker on the PAID fallback path: during a sidecar outage a burst of gated searches
// must not become a burst of per-call API requests. More than 4 attempts in 60s opens the breaker
// (skip Haiku, return null ⇒ gate abstains — fail open); half-open probe after 5 min cool-down.
// Logs once per state TRANSITION only. See lib/haiku-breaker.js.
const breaker = createBreaker({
  onTransition: (state, why) => process.stderr.write(`[embed-haiku] breaker ${state} (${why})\n`),
});

function apiKey() {
  return process.env.ANTHROPIC_API_KEY || '';
}

// Call the Anthropic messages API via raw HTTPS (no SDK dependency).
function callClaude(messages, maxTokens = 256) {
  const key = apiKey();
  if (!key) return Promise.reject(new Error('ANTHROPIC_API_KEY not set'));

  const body = JSON.stringify({
    model: MODEL,
    max_tokens: maxTokens,
    messages,
  });

  return new Promise((resolve, reject) => {
    const req = https.request(
      {
        hostname: 'api.anthropic.com',
        path: '/v1/messages',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
          'x-api-key': key,
          'anthropic-version': '2023-06-01',
        },
      },
      (res) => {
        let s = '';
        res.on('data', (d) => { s += d; });
        res.on('end', () => {
          try { resolve(JSON.parse(s)); }
          catch { reject(new Error('bad json from API')); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(TIMEOUT_MS, () => req.destroy(new Error('haiku gate timeout')));
    req.write(body);
    req.end();
  });
}

// noteText: extract the plain text from a note candidate (mirrors context-gate.js noteText)
function noteText(n) {
  if (!n) return '';
  return [n.title, n.summary, n.note, n.knowledge].filter(Boolean).join(' ');
}

// Simple lexical score for pre-ranking before sending to Haiku (avoids sending irrelevant noise)
function lexScore(queryToks, noteStr) {
  const ntoks = new Set(noteStr.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  let hits = 0;
  for (const t of queryToks) if (ntoks.has(t)) hits++;
  return hits;
}

// Returns a gateTask-compatible result object, or null on any error (caller abstains).
async function haikusGate(task, notes) {
  if (!apiKey()) return null;
  const queryText = [task && task.label, task && task.summary, task && task.spec]
    .filter(Boolean).join(' ').trim();
  if (!queryText || !notes || notes.length === 0) return null;

  // Pre-rank by lexical score and take top-N
  const queryToks = new Set(queryText.toLowerCase().split(/\W+/).filter((t) => t.length > 2));
  const ranked = notes
    .map((n) => ({ n, score: lexScore(queryToks, noteText(n)) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_NOTES)
    .map(({ n }) => n);

  // Breaker check comes AFTER the eligibility guards above — no-op paths (missing key, empty
  // query/notes) never count as attempts. Open breaker ⇒ skip the paid call; caller abstains.
  if (!breaker.allow()) return null;

  const noteList = ranked.map((n, i) =>
    `[${i + 1}] key=${n.key || n.id || '?'}\n    ${String(noteText(n)).slice(0, 200)}`
  ).join('\n');

  const prompt = `You are a retrieval-augmentation gate. Given a task and a list of knowledge notes, decide if any note contains a SPECIFIC, EMPIRICAL, PROJECT-LOCAL fact that would genuinely help with this exact task (a past bug, decision, root cause, or measured finding from this codebase). General advice does not qualify.

Task: ${queryText.slice(0, 300)}

Notes:
${noteList}

Reply with JSON only: {"inject": true|false, "key": "<note key or null>", "reason": "<one sentence>"}`;

  let resp;
  try {
    resp = await callClaude([{ role: 'user', content: prompt }], 128);
  } catch {
    breaker.failure();  // network/timeout — re-opens a half-open probe; no-op when closed
    return null;        // any failure → caller abstains
  }
  breaker.success();    // API answered — closes a half-open probe; no-op when closed
  try {
    const text = resp?.content?.[0]?.text || '';
    const match = text.match(/\{[\s\S]*\}/);
    if (!match) return null;
    const parsed = JSON.parse(match[0]);
    const topKey = parsed.key && parsed.key !== 'null' ? parsed.key : (ranked[0]?.key || null);
    const usage = resp?.usage || null;
    return {
      decision: parsed.inject ? 'inject' : 'abstain',
      top1: parsed.inject ? 0.6 : 0,   // synthetic — haiku doesn't produce cosine scores
      margin: 0, gap: 0, locality: 0,
      topType: 'empirical',
      topKey,
      via: 'haiku',
      reason: parsed.inject ? 'haiku-gate-inject' : 'haiku-gate-abstain',
      usage,
    };
  } catch {
    return null;  // any failure → caller abstains
  }
}

module.exports = { haikusGate };
