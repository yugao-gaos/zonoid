'use strict';
const delta = require('../lib/delta');
const overlayStore = require('../lib/overlay');
const graphStore = require('../lib/graph-store');
const path = require('path');
const fs = require('fs');
const { compileSearchContext } = require('../lib/search/context-compiler');

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, buildGraph, state, targetOverlay, overlayFor,
    isTruthy, leanLearnings, digestRejected } = ctx;

  if (p === '/graph/delta' && m === 'GET') {
    const parsed = delta.parseSince(u.searchParams.get('since'));
    if (!parsed.ok) { send(res, 400, { ok: false, error: parsed.error }); return true; }
    const ws = u.searchParams.get('workspace');
    if (!ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const g = buildGraph(ws);
    const ov = overlayFor(ws);
    send(res, 200, delta.computeDelta(g.tasks, ov, parsed.ms)); return true;
  }

  // Explicit pull trigger for the file-drop minting substrate (multi-harness plan Phase 2): an
  // adapter that just dropped a stub file calls POST /sync { workspace? } for immediate adoption
  // instead of waiting for the watcher/TTL. Forces a re-aggregation of the target workspace and
  // reports { adopted: [task_key...], suggestions: { <task_key>: [...] } }.
  //   adopted     = task keys newly seen in THIS sync — derived from overlay.timestamps, the
  //                 existing first-sighting record (a key with no timestamps entry before this
  //                 build has never been adopted). No new persistence: buildGraph already stamps
  //                 firstSeen for the daemon's own workspace; for a non-current workspace this
  //                 route stamps the same record itself, so a second /sync returns adopted: [].
  //   suggestions = per adopted task, the same top-5 link suggestions GET /task/suggest serves
  //                 (shared suggestForTask helper) — the wiring nudge, in-band.
  if (p === '/sync' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'no workspace: POST /workspace first or pass { workspace }' }); return true; }
    const prevKnown = new Set(Object.keys(T.ov.timestamps || {}));
    ctx.cache.agg.delete(T.ws); ctx.cache.aggAt.delete(T.ws);   // force the pull past the TTL cache
    const g = buildGraph(T.ws);
    const adopted = g.tasks.filter((t) => t.kind !== 'note' && !prevKnown.has(t.id)).map((t) => t.id);
    // Idempotency for non-current workspaces: buildGraph only stamps timestamps when ws is the
    // daemon's own workspace. Stamp any unstamped adoptee here (no-op for the own-ws case, where
    // T.ov IS state.overlay and buildGraph already stamped it).
    let dirty = false;
    const nowIso = new Date().toISOString();
    for (const key of adopted) {
      if (!T.ov.timestamps[key]) {
        const t = g.tasks.find((x) => x.id === key);
        T.ov.timestamps[key] = { firstSeen: nowIso, lastChanged: nowIso, lastStatus: t ? t.status : 'pending' };
        dirty = true;
      }
    }
    if (dirty) T.save();
    const suggestions = {};
    for (const key of adopted) {
      const target = g.tasks.find((x) => x.id === key);
      if (target) suggestions[key] = (await ctx.suggestForTask(g, target)).suggestions;
    }
    ctx.notifyChange();
    send(res, 200, { ok: true, workspace: T.ws, adopted, suggestions }); return true;
  }

  if (p === '/graph/init' && m === 'POST') {
    const b = await readBody(req);
    const { ws } = targetOverlay(b, u);
    if (!ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    graphStore.open(path.join(ws, '.graph'));
    graphStore.initGitAttributes(ws);
    fs.writeFileSync(path.join(ws, '.graph', '.gitkeep'), '');
    send(res, 200, { ok: true, workspace: ws }); return true;
  }

  if (p === '/learnings') {
    const ws = u.searchParams.get('workspace');
    if (!ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const g = buildGraph(ws);
    const ov = overlayFor(ws);
    const verdicts = [];
    for (const [key, items] of Object.entries(ov.knowledge || {})) {
      for (const it of (items || [])) {
        let v = it && it.value;
        if (typeof v === 'string') { try { v = JSON.parse(v); } catch { v = null; } }
        if (v && typeof v === 'object' && 'winner' in v) verdicts.push({ key, verdict: v });
      }
    }
    const byChanged = (a, b) => String((ov.timestamps[b.id] || {}).lastChanged || '').localeCompare(String((ov.timestamps[a.id] || {}).lastChanged || ''));
    const failures = g.tasks.filter((t) => t.status === 'failed' || t.status === 'canceled')
      .sort(byChanged).slice(0, 25)
      .map((t) => ({ key: t.id, label: t.label, status: t.status, note: ov.notes[t.id] || '' }));
    const recent = g.tasks.filter((t) => t.status === 'done' && (ov.summaries[t.id] || ''))
      .sort(byChanged).slice(0, 25)
      .map((t) => ({ key: t.id, label: t.label, summary: ov.summaries[t.id] || '' }));
    const labelFor = (k) => { const t = g.tasks.find((x) => x.id === k); return t ? t.label : ''; };
    const rejected = digestRejected(verdicts, failures, labelFor);
    const full = { verdicts: verdicts.slice(0, 25), failures, recent, rejected };
    const compact = isTruthy(u.searchParams.get('compact'));
    send(res, 200, compact ? leanLearnings(full) : full); return true;
  }

  if (p === '/search') {
    const result = await compileSearchContext(ctx, { req, u });
    send(res, result.status, result.body); return true;
  }

  if (p === '/note/chain') {
    const raw = u.searchParams.get('key') || u.searchParams.get('id') || '';
    const id = String(raw).replace(/^note:/, '');
    const T = targetOverlay(null, u);
    const chain = overlayStore.noteChain(T.ov, id).map((cid) => {
      const n = T.ov.note_nodes[cid];
      return { key: 'note:' + cid, title: n.title, validFrom: n.validFrom || null, validTo: n.validTo || null, current: !n.validTo };
    });
    send(res, 200, { key: 'note:' + id, workspace: T.ws, chain }); return true;
  }

  if (p === '/context-classify' && m === 'POST') {
    const b = await readBody(req);
    const prompt = String(b.prompt || '').trim();
    if (!prompt) { send(res, 400, { ok: false, error: 'prompt required' }); return true; }
    const { contextClassify } = require('../lib/context-classify-core');
    const T = targetOverlay(b, u);
    send(res, 200, await contextClassify(prompt, ctx, T.ws)); return true;
  }

  // ASK-vs-PREDICT preference gate (lib/ask-gate.js, the ask-by-default classifier). The dispatcher
  // POSTs a pending decision + (optional) hard-override flags; the daemon recalls stored preference
  // notes via the SAME semantic path /search uses (cosine of the decision text against note vecs,
  // grounded on notes tagged category:"preference" PLUS general decision notes), runs the four-guard
  // gate, and returns ask/predict with the matched note. Every verdict is appended to
  // .graph/ask-journal.jsonl — the training corpus for the learned ask-gate (T3); schema parallels
  // .graph/gate-journal.jsonl. Like the gated /search path, the FIRST call may lazy-load MiniLM
  // (10–90s); embed() degrading to null ⇒ all-zero scores ⇒ ask('low-confidence') — conservative.
  if (p === '/ask-gate' && m === 'POST') {
    const { runAskGate } = require('../lib/ask-gate-recall');
    const b = await readBody(req);
    const decision = String(b.decision || b.query || '').trim();
    if (!decision) { send(res, 400, { ok: false, error: 'decision (or query) required' }); return true; }
    const T = targetOverlay(b, u);
    const ws = T.ws;
    const flags = {
      irreversible: !!b.irreversible, outward: !!(b.outward || b.outwardFacing),
      highImpact: !!b.highImpact, scopeExpansion: !!b.scopeExpansion, repeatedFailure: !!b.repeatedFailure,
    };
    const r = await runAskGate(ctx, ws, { decision, flags, tags: b.tags });
    send(res, 200, {
      decision: r.decision, reason: r.reason, override: r.override, overrideCategory: r.overrideCategory,
      top1: r.top1, margin: r.margin, gap: r.gap, locality: r.locality, topType: r.topType, via: r.via,
      appliedNote: r.decision === 'predict' && r.appliedNote
        ? { key: r.topKey, title: r.appliedNote.title || r.appliedNote.label || null, summary: r.appliedNote.summary || null }
        : null,
    });
    return true;
  }

  return false;
};
