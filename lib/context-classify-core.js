'use strict';
const path = require('path');

/**
 * Shared prompt-routing signals used by POST /context-classify and POST /classify.
 * Pure async function — no HTTP.
 */
async function contextClassify(prompt, ctx, workspace) {
  const { buildGraph, state, embed, cosine, gateTask, haikusGate } = ctx;
  const ws = workspace || state.workspace;
  const g = buildGraph(ws);
  const overlay = ctx.overlayFor ? ctx.overlayFor(ws) : null;
  const expectedMeta = ctx.embeddingMeta && overlay ? ctx.embeddingMeta(overlay) : null;

  const words = prompt.split(/\s+/).filter(Boolean).length;
  let complexity = words < 15 ? 0.2 : words <= 40 ? 0.5 : 0.8;
  if (/\b(audit|migrate|refactor|all\s+files|entire|sweep)\b/i.test(prompt)) {
    complexity = Math.min(1.0, complexity + 0.2);
  }

  const { contentTokens: ctTokens } = require('./context-gate');
  const promptToks = new Set(ctTokens(prompt));
  const dagCandidates = g.tasks.filter((t) => {
    if (t.kind === 'note') return !t.validTo;
    return t.status === 'done';
  });
  const dagScored = dagCandidates.map((t) => {
    const text = `${t.label || ''} ${t.summary || ''}`;
    const toks = ctTokens(text);
    const shared = toks.filter((tok) => promptToks.has(tok));
    return { t, shared: shared.length, key: t.id, label: t.label || '' };
  }).filter((x) => x.shared >= 2);
  const dag_score = Math.min(1.0, dagScored.length / 10);

  const noteCands = g.tasks
    .filter((n) => (n.kind || 'task') === 'note' && !n.validTo)
    .map((n) => ({ key: n.id, title: n.label, summary: n.summary, vec: n.vec, vecMeta: n.vecMeta, vecs: n.vecs, vecsMeta: n.vecsMeta }));

  let gateResult;
  try {
    gateResult = await Promise.race([
      gateTask({ label: prompt }, noteCands, { embedQuery: (text) => embed(text, { mode: 'query', overlay }), cosine, expectedMeta }),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 1800)),
    ]);
  } catch (_) {
    const haiku = await haikusGate({ label: prompt }, noteCands).catch(() => null);
    if (haiku) {
      gateResult = haiku;
      if (haiku.usage) {
        try {
          const costLogPath = path.join(__dirname, '..', 'logs', 'cron-token-usage.jsonl');
          const u2 = haiku.usage;
          require('fs').mkdirSync(path.dirname(costLogPath), { recursive: true });
          require('fs').appendFileSync(costLogPath, JSON.stringify({
            ts: new Date().toISOString(), event: 'haiku_gate', model: 'claude-haiku-4-5-20251001',
            input_tokens: u2.input_tokens || 0, output_tokens: u2.output_tokens || 0,
            cache_read_tokens: u2.cache_read_input_tokens || 0,
            total_tokens: (u2.input_tokens || 0) + (u2.output_tokens || 0) + (u2.cache_read_input_tokens || 0),
          }) + '\n');
        } catch { /* best effort */ }
      }
    } else {
      const { contentTokens: ct2 } = require('./context-gate');
      const qt = new Set(ct2(prompt));
      gateResult = await gateTask({ label: prompt }, noteCands, {
        lexScore: (_qText, n) => {
          const nt2 = ct2(`${n.title || ''} ${n.summary || ''}`);
          return nt2.filter((t) => qt.has(t)).length / Math.max(nt2.length, 1);
        },
      });
    }
  }

  const rag_score = gateResult.top1 || 0;
  let gate_decision;
  if (gateResult.decision === 'inject') gate_decision = 'inject';
  else if (dag_score >= 0.4) gate_decision = 'scaffold';
  else gate_decision = 'abstain';

  const result = { rag_score, dag_score, complexity, gate_decision };
  if (gate_decision === 'inject') {
    const topKey = gateResult.topKey;
    const topNote = noteCands.find((n) => n.key === topKey);
    const others = noteCands.filter((n) => n.key !== topKey).slice(0, 4);
    result.top_notes = [topNote, ...others].filter(Boolean).map((n) => ({
      key: n.key, title: n.title, summary: String(n.summary || '').slice(0, 200),
    }));
  } else if (gate_decision === 'scaffold') {
    dagScored.sort((a, b) => b.shared - a.shared);
    result.scaffold_keys = dagScored.slice(0, 3).map((x) => ({ key: x.key, label: x.label }));
  }
  return result;
}

module.exports = { contextClassify };
