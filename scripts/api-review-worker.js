#!/usr/bin/env node
'use strict';

/**
 * Runs ONE API-backed same-node code review outside the daemon process.
 *
 * The daemon owns scheduling, leases, concurrency, and timeout enforcement (lib/headless-drain.js
 * REVIEW-VERDICT drain). This worker only performs the CPU/model-heavy round trip:
 *   GET /task/detail + GET /attempt/diff  →  provider.callApi (rubric review)  →
 *   POST /overlay/status (the submit_verdict HTTP path)
 * mirroring scripts/api-judge-worker.js for the judge drain. It NEVER merges — APPROVE only records
 * approved + pending merge state (the review-merge drain lands it later); KICK_BACK marks the
 * implementation task failed for rework. No verdict is ever defaulted: an unparseable model reply
 * or a missing diff exits non-zero WITHOUT writing anything.
 *
 * argv[2] is a JSON object: { provider, daemonUrl, key, workspace?, repo_path?, model?, apiKey?,
 * timeoutMs?, rubric?, agent_id? }.
 */

const http = require('http');

const DEFAULT_AGENT_ID = 'headless-review-verdict-drain';
// Cap the diff text handed to the model so a huge attempt can't blow the context window.
const MAX_DIFF_CHARS = Number(process.env.ORCH_REVIEW_DIFF_MAX_CHARS) || 60000;

function daemonToken() {
  try { return require('../lib/mcp-core').readToken(); } catch { return null; }
}

/** Minimal JSON-over-HTTP helper (Node http, no dependencies). Resolves { status, body }. */
function httpJson(method, url, body, timeoutMs) {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = body != null ? JSON.stringify(body) : null;
    const headers = { accept: 'application/json' };
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    const token = daemonToken();
    if (token) headers['x-orch-token'] = token;
    const req = http.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method,
      headers,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = { raw: text }; }
        resolve({ status: res.statusCode, body: parsed });
      });
    });
    req.setTimeout(Math.max(1000, Number(timeoutMs) || 30000), () => req.destroy(new Error(`HTTP timeout: ${method} ${u.pathname}`)));
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

/**
 * Parse the model's verdict from its reply text. Prefers an explicit JSON
 * `"verdict":"APPROVE"|"KICK_BACK"` field (+ optional `"reason"`); falls back to the first bare
 * APPROVE / KICK_BACK token. Returns { verdict: 'APPROVE'|'KICK_BACK'|null, reason: string|null }
 * — a null verdict means the reply was inconclusive and NOTHING must be written.
 */
function parseVerdict(text) {
  const s = String(text || '');
  const m = s.match(/"verdict"\s*:\s*"(APPROVE|KICK_BACK)"/i);
  const r = s.match(/"reason"\s*:\s*"((?:[^"\\]|\\.)*)"/);
  let reason = null;
  if (r) {
    try { reason = JSON.parse(`"${r[1]}"`); } catch { reason = r[1]; }
  }
  if (m) return { verdict: m[1].toUpperCase(), reason };
  const bare = s.match(/\b(APPROVE|KICK_BACK)\b/);
  if (bare) return { verdict: bare[1], reason };
  return { verdict: null, reason: null };
}

/** Build the chat messages for the review call: system rubric + user context (detail + diff). */
function buildReviewMessages({ key, rubric, detail, diff }) {
  const task = (detail && detail.task) || {};
  const stat = (diff && diff.stat) || '';
  const diffText = String((diff && diff.diff) || '');
  const truncated = diffText.length > MAX_DIFF_CHARS;
  const body = truncated ? `${diffText.slice(0, MAX_DIFF_CHARS)}\n... [diff truncated at ${MAX_DIFF_CHARS} chars]` : diffText;
  const system = [
    `You are a strict code reviewer producing a same-node review verdict for orchestrator task ${key}.`,
    rubric || '',
    'Respond with EXACTLY one JSON object and nothing else:',
    '{"verdict":"APPROVE","reason":"<one-line rationale>"} to approve, or',
    '{"verdict":"KICK_BACK","reason":"<what must change>"} to send it back for rework.',
    'Never propose merging; merging is not your call.',
  ].filter(Boolean).join('\n');
  const user = [
    `Task: ${task.label || task.subject || key}`,
    task.description ? `Description: ${String(task.description).slice(0, 2000)}` : '',
    detail && detail.summary ? `Worker summary: ${String(detail.summary).slice(0, 2000)}` : '',
    stat ? `Diff stat:\n${stat}` : '',
    `Attempt diff (vs base):\n${body}`,
  ].filter(Boolean).join('\n\n');
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];
}

/** The submit_verdict HTTP bodies — mirror lib/mcp-core runSubconsciousAssignment submit_verdict. */
function verdictStatusBody({ verdict, reason, key, workspace, agentId }) {
  const agent = agentId || DEFAULT_AGENT_ID;
  if (verdict === 'APPROVE') {
    const why = reason || 'Attempt approved by headless review-verdict drain.';
    return {
      workspace: workspace || undefined,
      key,
      status: 'tested',
      summary: `APPROVE: ${why}`.slice(0, 2000),
      note: why,
      agent_id: agent,
      review: {
        review_state: 'approved',
        review_verdict: 'APPROVE',
        review_reason: why,
        review_note: why,
        review_agent: agent,
        merge_state: 'pending',
      },
    };
  }
  const why = reason || 'Headless review-verdict drain kicked back the attempt.';
  return {
    workspace: workspace || undefined,
    key,
    status: 'failed',
    summary: `KICK_BACK: ${why}`.slice(0, 2000),
    note: why,
    agent_id: agent,
    review: {
      review_state: 'rejected',
      review_verdict: 'KICK_BACK',
      review_reason: why,
      review_note: why,
      review_agent: agent,
      merge_state: 'blocked',
    },
  };
}

async function main() {
  let args;
  try {
    args = JSON.parse(process.argv[2] || '{}');
  } catch (e) {
    process.stderr.write(`api-review-worker: invalid JSON args: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }

  const backend = require('../lib/llm-backend');
  const provider = backend.getProvider(args.provider);
  if (!provider || provider.kind !== 'api' || typeof provider.callApi !== 'function') {
    process.stderr.write(`api-review-worker: invalid api provider ${JSON.stringify(args.provider)}\n`);
    process.exit(1);
  }
  const daemonUrl = String(args.daemonUrl || '').replace(/\/$/, '');
  const key = String(args.key || '');
  if (!daemonUrl || !key) {
    process.stderr.write('api-review-worker: daemonUrl and key are required\n');
    process.exit(1);
  }

  const ws = args.workspace ? `&workspace=${encodeURIComponent(args.workspace)}` : '';
  const repo = args.repo_path ? `&repo_path=${encodeURIComponent(args.repo_path)}` : '';
  const httpTimeoutMs = Math.max(1000, Number(args.timeoutMs) || 30000);

  // 1) Pull the task detail + attempt diff. No diff ⇒ nothing to review — fail WITHOUT a verdict
  // (a reviewer must never guess from metadata alone).
  const detail = await httpJson('GET', `${daemonUrl}/task/detail?key=${encodeURIComponent(key)}${ws}`, null, httpTimeoutMs);
  if (detail.status < 200 || detail.status >= 300) {
    process.stderr.write(`api-review-worker: GET /task/detail HTTP ${detail.status}\n`);
    process.exit(1);
  }
  const diff = await httpJson('GET', `${daemonUrl}/attempt/diff?key=${encodeURIComponent(key)}${ws}${repo}`, null, httpTimeoutMs);
  if (diff.status < 200 || diff.status >= 300 || !diff.body || !diff.body.diff) {
    process.stderr.write(`api-review-worker: attempt diff unavailable (HTTP ${diff.status})${diff.body && diff.body.error ? `: ${diff.body.error}` : ''}\n`);
    process.exit(1);
  }

  // 2) Reason IN the worker via the hosted API (the daemon stays free).
  let out;
  try {
    out = await provider.callApi({
      messages: buildReviewMessages({ key, rubric: args.rubric, detail: detail.body, diff: diff.body }),
      model: args.model || undefined,
      key: args.apiKey || undefined,
      timeoutMs: args.timeoutMs,
    });
  } catch (e) {
    // Keep throttle text visible so the drain's isThrottled() feeds the backoff governor.
    process.stderr.write(`api-review-worker: callApi failed: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }
  const parsed = parseVerdict(out && out.text);
  if (!parsed.verdict) {
    process.stderr.write(`api-review-worker: no APPROVE/KICK_BACK verdict in model reply: ${String(out && out.text || '').slice(0, 400)}\n`);
    process.exit(1);
  }

  // 3) Apply the verdict through the submit_verdict HTTP path (POST /overlay/status). NEVER merge.
  const post = await httpJson('POST', `${daemonUrl}/overlay/status`, verdictStatusBody({
    verdict: parsed.verdict,
    reason: parsed.reason,
    key,
    workspace: args.workspace,
    agentId: args.agent_id,
  }), httpTimeoutMs);
  if (post.status < 200 || post.status >= 300) {
    process.stderr.write(`api-review-worker: POST /overlay/status HTTP ${post.status}${post.body && post.body.error ? `: ${post.body.error}` : ''}\n`);
    process.exit(1);
  }
  process.stdout.write(`review verdict: ${parsed.verdict} task=${key}\n`);
  process.exit(0);
}

module.exports = { parseVerdict, buildReviewMessages, verdictStatusBody };

if (require.main === module) main();
