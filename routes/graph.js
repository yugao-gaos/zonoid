'use strict';
const delta = require('../lib/delta');
const overlayStore = require('../lib/overlay');
const graphStore = require('../lib/graph-store');
const judge = require('../lib/judge');
const { contentTokens, classifyNoteType, noteText } = require('../lib/context-gate');
const { maxCosine, nodeVecs } = require('../lib/embed');
const { rerank } = require('../lib/rerank');
const path = require('path');
const fs = require('fs');
const recallJournal = require('../lib/recall-outcome-journal');

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
    const { embed, cosine, suggestToks, scoreNodeAgainstTokens, knowledgeText,
      gateTask, gatedSearchCounts, checkGatedRateLimit, EMBED_MODEL,
      noteCurrentAsOf } = ctx;
    const q = u.searchParams.get('q') || '';
    const k = Math.max(1, Math.min(parseInt(u.searchParams.get('k') || '5', 10) || 5, 50));
    // asOf (ISO instant): as-of retrieval — return the note that was CURRENT at that time, not just
    //   the latest. Notes outside their [validFrom, validTo) window are dropped. Absent ⇒ default,
    //   which returns only notes still current (validTo == null) PLUS all non-temporal/task nodes.
    // history=1: include superseded notes too (don't drop on validTo), so a caller can see the
    //   full timeline for a query. Ignored when asOf is set (asOf already picks one point in time).
    const asOf = u.searchParams.get('asOf') || '';
    // knownAsOf (ISO instant): TRANSACTION-time axis — "as the KB was KNOWN at time T". Drops note
    //   hits whose created_at (when the KB learned the fact) is AFTER T, so a backdated insert (valid_from
    //   set in the past) can't silently rewrite what an earlier-knowledge query returns. COMPOSES with
    //   asOf (valid-time): asOf alone = true-as-of-T1; +knownAsOf = recorded-by-T2; both = the canonical
    //   bitemporal query. Absent ⇒ behavior identical to before (back-compat). Fail-open on unparseable.
    const knownAsOf = u.searchParams.get('knownAsOf') || '';
    const history = isTruthy(u.searchParams.get('history'));
    const ws = u.searchParams.get('workspace');
    if (!ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const task_key = u.searchParams.get('task_key') || '';
    // Iterative retrieval: `round` (1-based) + `exclude_keys` (comma-separated note keys already
    // injected in prior rounds). Excluded keys are dropped from RAG candidates before ranking.
    // The response gains `continue` — true iff round < 3 AND a NEW note scored >= 0.5 (plateau verdict).
    const round = Math.max(1, parseInt(u.searchParams.get('round') || '1', 10) || 1);
    const excludeKeys = new Set((u.searchParams.get('exclude_keys') || '').split(',').map((s) => s.trim()).filter(Boolean));
    const plateauContinue = (notes) => round < 3 && notes.some((n) => n.tier === 'rag' && (n.kind || 'note') === 'note' && n.score >= 0.5);
    const gated = isTruthy(u.searchParams.get('gated'));
    const g = buildGraph(ws);
    // PENDING-DUP recall invisibility: a note admitted PROVISIONAL on a write-time dup-guard fire is
    // RETRIEVAL-INVISIBLE until the dup-judge clears it — that's what preserves the guard's purpose.
    // Invisibility is the PURE timeout derivation (judge.pendingDupState): pending AND not-yet-timed-out
    // ⇒ excluded; a TIMED-OUT pending note falls back to VISIBLE (provisional) without being de-queued.
    const _ovDup = overlayFor(ws);
    const _dupTimeout = judge.judgingTimeoutMs(_ovDup);
    const _dupNow = Date.now();
    const dupInvisible = (node) => {
      if ((node.kind || 'task') !== 'note' || !node.pending_dup) return false;
      return !judge.pendingDupState(_ovDup, node.id, _dupNow, _dupTimeout).visible;
    };
    // GATED retrieval (?gated=1) — the context-need gate (lib/context-gate.js, the abstain-by-
    // default classifier calibrated on test/context-gate-regression.test.js) now ANNOTATES the
    // bundle instead of suppressing it: gated and ungated calls run the SAME single pipeline
    // (DAG tier → temporal filter → hybrid scoring → structBoost rerank → path provenance →
    // sorted top-k), and gated responses ADD gate metadata + inject:true flags on approved
    // results. The gate's four guards run over the same note-only candidate subset, using
    // PRE-boost raw scores, so inject/abstain decisions are calibration-identical to the old
    // suppressing branch. NOTE: the FIRST gated call may take 10–90s while MiniLM lazy-loads
    // (lib/embed.js); embed() degrading to null ⇒ all-zero gate scores ⇒
    // abstain('low-confidence') — conservative, never a hard failure.
    // DAG tier: collect context_deps of the requested task — always inject, no gate.
    const dagNotes = [];
    // DAG-ONLY claim context (Judge E): when a worker consults this with a task_key, the
    // auto-injected claim context is the JUDGED DAG neighborhood ONLY — the RAG-fill tier is
    // dropped from the returned bundle. This is SAFE only under Judge D's ready-gate guarantee:
    // a task is not 'ready'/claimable until its wirings have been judged, so by claim time its
    // context_deps are the complete-and-judged set (weight-0/unjudged edges are already excluded
    // from the projection — daemon.js buildGraph filters them — so they never appear here).
    // INVARIANT GUARD: if D's timeout fired and the task fell back to 'ready' with surviving
    // unjudged edges (taskNode.provisional), its DAG is NOT guaranteed complete — do NOT go
    // DAG-only-blind. For a provisional task we KEEP the RAG-fill (below), so it still gets
    // fallback context. dagOnly stays false unless we positively confirm a fully-judged task.
    let dagOnly = false;
    if (task_key) {
      const taskNode = g.tasks.find(t => t.id === task_key);
      if (taskNode) {
        dagOnly = !taskNode.provisional;  // fully-judged ⇒ DAG-only; provisional ⇒ keep RAG-fill
        // SUPERSEDE-AWARE DAG injection: a context_dep may point at a note that has since been
        // SUPERSEDED. Injecting the stale note verbatim at score 1.0 would surface dead truth (and
        // under dagOnly, the current replacement would never appear at all since RAG-fill is dropped).
        // So before pushing, walk the note's supersededBy chain to the CURRENT HEAD and inject that.
        // supersededBy is already 'note:'-prefixed in the built graph (daemon.js), matching node ids.
        const resolvedHeads = new Set();  // head ids pushed this loop — dedup two deps → one head.
        for (const depKey of (taskNode.context_deps || [])) {
          let noteNode = g.tasks.find(t => t.id === depKey);
          if (!(noteNode && noteNode.kind === 'note')) continue;
          // Follow supersededBy to the current head. Cycle guard via `seen`; if the chain points at
          // an id not present in g.tasks (archived/swept), stop at the last resolvable node.
          const seen = new Set([noteNode.id]);
          while (noteNode.supersededBy) {
            const next = g.tasks.find(t => t.id === noteNode.supersededBy);
            if (!next || seen.has(next.id)) break;
            seen.add(next.id);
            noteNode = next;
          }
          if (resolvedHeads.has(noteNode.id)) continue;  // another dep already resolved to this head
          resolvedHeads.add(noteNode.id);
          const viaSupersede = noteNode.id !== depKey;
          dagNotes.push({
            key: noteNode.id,
            title: noteNode.label,
            summary: String(noteNode.summary || '').slice(0, 200),
            score: 1.0,
            kind: 'note',
            tier: 'dag',
            via: 'dag',
            path: [`context_dep of task/${task_key}${viaSupersede ? ' (via supersede)' : ''}`]
          });
        }
      }
    }
    const dagKeys = new Set(dagNotes.map(n => n.key));

    // System tier: notes with category="system" — always injected, every query, no gate.
    // These are workspace-level anchors (durable spec, standing constraints) that every
    // agent should see regardless of what it is searching for.
    const sysNotes = [];
    for (const n of g.tasks) {
      if ((n.kind || 'task') !== 'note') continue;
      if (n.validTo) continue;           // superseded — show only current head
      if (n.category !== 'system') continue;
      if (dupInvisible(n)) continue;
      sysNotes.push({ key: n.id, title: n.label, summary: String(n.summary || '').slice(0, 200), score: 1.0, kind: 'note', tier: 'system', inject: true, via: 'system', path: [] });
    }
    const sysKeys = new Set(sysNotes.map(n => n.key));

    // Build adjacency map for BFS path computation (undirected over deps + context_deps).
    const adjMap = new Map(); // key -> [{neighborKey, edgeType}]
    const ensureAdj = (k) => { if (!adjMap.has(k)) adjMap.set(k, []); };
    for (const node of g.tasks) {
      ensureAdj(node.id);
      for (const dep of (node.deps || [])) {
        ensureAdj(dep);
        adjMap.get(node.id).push({ neighborKey: dep, edgeType: 'dep' });
        adjMap.get(dep).push({ neighborKey: node.id, edgeType: 'dep' });
      }
      for (const dep of (node.context_deps || [])) {
        ensureAdj(dep);
        adjMap.get(node.id).push({ neighborKey: dep, edgeType: 'context_dep' });
        adjMap.get(dep).push({ neighborKey: node.id, edgeType: 'context_dep' });
      }
    }

    // BFS: shortest path (max 2 hops, max 50 nodes visited) from startKey to any node in targetSet.
    // Returns array of hop strings like ["context_dep:note:foo"], or null if not found.
    const bfsPath = (startKey, targetSet) => {
      if (targetSet.has(startKey)) return [];
      const visited = new Set([startKey]);
      const queue = [{ key: startKey, path: [] }];
      let visits = 0;
      while (queue.length > 0 && visits < 50) {
        const { key: cur, path } = queue.shift();
        if (path.length >= 2) continue;
        visits++;
        for (const { neighborKey, edgeType } of (adjMap.get(cur) || [])) {
          if (visited.has(neighborKey)) continue;
          visited.add(neighborKey);
          const newPath = [...path, `${edgeType}:${neighborKey}`];
          if (targetSet.has(neighborKey)) return newPath;
          queue.push({ key: neighborKey, path: newPath });
        }
      }
      return null;
    };

    const qt = suggestToks(q);
    const qvec = await embed(q);   // null-safe: null ⇒ pure-lexical (back-compat)
    const knownT = knownAsOf ? Date.parse(knownAsOf) : NaN;
    const temporalOk = (node) => {
      // valid-time axis (validFrom/validTo) — unchanged.
      let ok;
      if (asOf) ok = noteCurrentAsOf(node, asOf);            // point-in-time
      else if (history) ok = true;                           // whole timeline
      else if ((node.kind || 'task') !== 'note') ok = true;  // tasks always pass
      else ok = !node.validTo;                               // default: only still-current notes
      if (!ok) return false;
      // transaction-time axis (created_at) — drop note hits not yet KNOWN at knownAsOf. Composes
      // with the valid-time decision above. Fail-open on unparseable dates (cf. noteCurrentAsOf).
      if (knownAsOf && (node.kind || 'task') === 'note' && !Number.isNaN(knownT)) {
        const c = Date.parse(node.created_at);
        if (!Number.isNaN(c) && c > knownT) return false;    // recorded after T ⇒ not yet known
      }
      return true;
    };
    // Score one item HYBRID: semantic cosine when both the query AND the item have a vector,
    // else the lexical token overlap. Returns { score, via }. MULTI-VEC: vecNode carries EITHER a
    // single `.vec` (notes, knowledge items) OR a `.vecs` array (tasks); maxCosine takes the max
    // cosine over whichever it finds — identical to single-vec cosine when there is exactly one.
    const scoreHybrid = (vecNode, lexNode) => {
      if (qvec && nodeVecs(vecNode).length > 0) return { score: maxCosine(qvec, vecNode), via: 'semantic' };
      return { score: scoreNodeAgainstTokens(lexNode, qt).score, via: 'lexical' };
    };
    // Gate candidate pool: the SAME note subset the old gated branch scored —
    // kind 'note', still-current, non-DAG, non-excluded — with the RAW (pre-structBoost) cosine,
    // so gate calibration is unaffected by reranking. No query vector ⇒ all-zero scores ⇒ the
    // gate abstains 'low-confidence', exactly as before. Always computed (shadow journal needs it
    // for ungated calls too; gated responses continue to use it for enforcement).
    const gateCands = [];
    let gateVia = 'lexical';
    for (const n of g.tasks) {
      if ((n.kind || 'task') !== 'note' || n.validTo || dagKeys.has(n.id) || sysKeys.has(n.id) || excludeKeys.has(n.id)) continue;
      if (dupInvisible(n)) continue;   // pending-dup note: retrieval-invisible until the dup-judge clears it
      let rawScore = 0;
      if (qvec && nodeVecs(n).length > 0) { rawScore = maxCosine(qvec, n); gateVia = 'semantic'; }
      gateCands.push({ key: n.id, title: n.label, summary: n.summary, score: rawScore, category: n.category || null, tags: n.tags || [] });
    }
    // KB-state / query metadata — computed once here; spread into both journal row variants below.
    const _kbTop1 = gateCands.length ? Math.max(...gateCands.map((c) => c.score)) : 0;
    const kbMeta = {
      kbCands: gateCands.length,
      cluster: gateCands.filter((c) => c.score >= _kbTop1 - 0.05).length,
      near45:  gateCands.filter((c) => c.score >= 0.45).length,
      qTokens: contentTokens(q).length,
      empTop10: (() => {
        if (!gateCands.length) return 0;
        const top10 = [...gateCands].sort((a, b) => b.score - a.score).slice(0, 10);
        const empCount = top10.filter((c) => classifyNoteType(noteText(c)) === 'empirical').length;
        return Math.round((empCount / top10.length) * 1000) / 1000;
      })(),
    };
    // Task-side features — extend journal schema before volume accumulates (retroactively impossible).
    // complexity: caller-supplied routing score preferred (model-routing hook computes it on the full
    // prompt at UserPromptSubmit time); fall back to inline heuristic on the search query itself.
    const _passedComplexity = parseFloat(u.searchParams.get('complexity') || '');
    const _qWords = q.split(/\s+/).filter(Boolean).length;
    const _taskNode = task_key ? g.tasks.find((t) => t.id === task_key) : null;
    const gateTaskInput = { label: q, tags: (_taskNode && _taskNode.tags) ? _taskNode.tags : [] };
    const _taskLabel = _taskNode ? (_taskNode.label || '') : '';
    const taskMeta = {
      qWords: _qWords,
      taskWords: _taskLabel.split(/\s+/).filter(Boolean).length,
      hasSpec: /\b(implement|add|build|fix|refactor|create|write|migrate|update|extend)\b/i.test(_taskLabel || q),
      complexity: Number.isFinite(_passedComplexity) ? _passedComplexity
        : Math.min(1.0, (_qWords < 15 ? 0.2 : _qWords <= 40 ? 0.5 : 0.8)
            + (/\b(audit|migrate|refactor|all\s+files|entire|sweep)\b/i.test(q) ? 0.2 : 0)),
    };
    // Anchor set for RAG path BFS: DAG-tier keys + the query task_key itself.
    const pathAnchors = new Set(dagKeys);
    if (task_key) pathAnchors.add(task_key);

    const ragResults = [];
    // (a) graph nodes (tasks + note nodes).
    for (const node of g.tasks) {
      if (sysKeys.has(node.id)) continue;  // skip system-tier notes (always injected above)
      if (dagKeys.has(node.id)) continue;  // skip DAG-injected notes
      if (excludeKeys.has(node.id)) continue;  // already injected in a prior round
      if (dupInvisible(node)) continue;    // pending-dup note: retrieval-invisible until the dup-judge clears it
      if (!temporalOk(node)) continue;
      const { score, via } = scoreHybrid(node, node);
      if (!(score > 0)) continue;
      const foundPath = bfsPath(node.id, pathAnchors);
      const r = { key: node.id, title: node.label, summary: String(node.summary || '').slice(0, 200), score: Math.round(score * 1000) / 1000, kind: node.kind || 'task', tier: 'rag', via, path: foundPath || [] };
      // Surface temporal provenance on note hits so callers can reason about state changes.
      if ((node.kind || 'task') === 'note' && (node.validFrom || node.validTo || node.supersededBy || node.supersedes)) {
        r.validFrom = node.validFrom || null; r.validTo = node.validTo || null;
        r.supersededBy = node.supersededBy || null; r.supersedes = node.supersedes || null;
        r.current = !node.validTo;
      }
      ragResults.push(r);
    }
    // (b) per-task Tier-2 knowledge items (overlay.knowledge[key][]) — not graph nodes, but
    // semantically searchable. Scored with the same hybrid path over a synthetic lex node.
    const ov = overlayFor(ws);
    for (const [tkey, items] of Object.entries(ov.knowledge || {})) {
      (items || []).forEach((it, i) => {
        const text = knowledgeText(it);
        if (!text) return;
        const key = `${tkey}#k${i}`;
        if (dagKeys.has(key)) return;  // skip DAG-injected items
        if (excludeKeys.has(key)) return;  // already injected in a prior round
        const lexNode = { label: text, summary: '' };
        const { score, via } = scoreHybrid({ vec: it && it._vec }, lexNode);
        if (!(score > 0)) return;
        // Knowledge items are children of tkey; path via the parent task node.
        let kPath;
        if (pathAnchors.has(tkey)) { kPath = [`dep:${tkey}`]; }
        else { const p = bfsPath(tkey, pathAnchors); kPath = p || []; }
        ragResults.push({ key, title: text.slice(0, 80), summary: text.slice(0, 200), score: Math.round(score * 1000) / 1000, kind: 'knowledge', tier: 'rag', via, path: kPath });
      });
    }
    // CONFIDENCE FLOOR: filter out note-kind RAG candidates whose recall-outcome confidence
    // falls below CONFIDENCE_FLOOR. Notes with no journal history are treated as confidence = 1.0
    // (new notes must not be penalised — that is corroboration's job). Only note-kind items
    // with a recorded history below the floor are excluded. Knowledge items always pass through.
    {
      const confMap = recallJournal.noteConfidenceMap(ws);
      const floor = recallJournal.CONFIDENCE_FLOOR;
      for (let i = ragResults.length - 1; i >= 0; i--) {
        const r = ragResults[i];
        if ((r.kind || 'task') !== 'note') continue;  // only filter note-kind items
        const conf = confMap.has(r.key) ? confMap.get(r.key) : 1.0;  // no history → pass through
        if (conf < floor) ragResults.splice(i, 1);
      }
    }
    ragResults.sort((a, b) => b.score - a.score);
    // CROSS-ENCODER RERANK (opt-in via ORCH_RERANK / ?rerank=1) — runs BETWEEN the cosine sort and
    // the structBoost block, so the cross-encoder supplies precision and structBoost stays the
    // additive structural prior on top of it. DEFAULT OFF: when the flag is absent this whole block
    // is skipped and ordering is byte-identical to today. NULL-SAFE: if the sidecar is unavailable
    // rerank() returns null and we keep the cosine order (no throw).
    // BLEND (not a hard offset): the new score is a convex blend of the existing cosine score and the
    // cross-encoder score, score = α·cosine + (1−α)·ce (ORCH_RERANK_ALPHA, default 0.5). Keeping
    // cosine weight means a high-cosine note the cross-encoder underrates is NOT buried — that fixes
    // the recall@k regression the earlier hard [1,2] offset caused (it froze the top-K order and let
    // the CE drop genuinely-relevant notes out of top-k). α=1 ⇒ pure cosine (rerank inert); α=0 ⇒
    // pure CE. K = ORCH_RERANK_K (default 50) is the recall shortlist fed to the CE — RAISE it to
    // relax the cheap cosine stage and let the CE see more candidates (two-stage retrieve-then-rerank:
    // loose recall, precise rerank). CRITICAL: this does NOT touch gateCands (computed far above on
    // RAW cosine) — the context-gate calibration is unaffected by reranking.
    // /search rerank is DEFAULT-ON (validated by the CE-3 A/B): it fires unless explicitly disabled
    // with ORCH_RERANK in {0,false,off} or ?rerank=0. Null-safe — if the cross-encoder sidecar is
    // unavailable, rerank() returns null and we keep cosine order, so default-on never breaks search
    // (it lazily spawns the sidecar on first use). suggest_links is DEFAULT-ON too (it surfaces to the
    // agent, who reviews each candidate — no weight-0 seed threshold to calibrate). The autowire path
    // stays OPT-IN behind a truthy ORCH_RERANK (its seed threshold is uncalibrated); ORCH_RERANK=0
    // force-disables all.
    const _rrEnv = String(process.env.ORCH_RERANK ?? '').trim().toLowerCase();
    const _rrParam = String(u.searchParams.get('rerank') ?? '').trim().toLowerCase();
    const _off = (v) => v === '0' || v === 'false' || v === 'off';
    const rerankOn = _rrParam ? !_off(_rrParam) : !_off(_rrEnv);
    if (rerankOn && ragResults.length > 1) {
      const K = Math.max(1, parseInt(process.env.ORCH_RERANK_K || '50', 10) || 50);
      const aRaw = parseFloat(process.env.ORCH_RERANK_ALPHA || '0.5');
      const ALPHA = Number.isFinite(aRaw) ? Math.min(1, Math.max(0, aRaw)) : 0.5;
      const shortlist = ragResults.slice(0, K);
      const ceScores = await rerank(q, shortlist.map((r) => `${r.title || ''}\n${r.summary || ''}`.trim()));
      if (Array.isArray(ceScores) && ceScores.length === shortlist.length) {
        for (let i = 0; i < shortlist.length; i++) {
          const cos = shortlist[i].score;   // pre-rerank cosine (or lexical) score for this item
          shortlist[i].ceScore = Math.round(ceScores[i] * 1000) / 1000;
          shortlist[i].reranked = true;
          shortlist[i].score = Math.round((ALPHA * cos + (1 - ALPHA) * ceScores[i]) * 1000) / 1000;
        }
        ragResults.sort((a, b) => b.score - a.score);
      }
      // ceScores null (sidecar loading/unavailable) ⇒ keep cosine order — best-effort precision only.
    }
    // Structural rerank: boost items whose graph neighbors also appear in ragResults.
    // "Structure outranks similarity once you have a foothold." (note-mqaaf1ox5pn)
    // Runs for BOTH gated and ungated calls — the gate already took its raw scores above.
    {
      // Build adjacency lookup: key → Set of neighbor keys (via deps + context_deps, both directions).
      const adjMap2 = new Map();
      for (const node of g.tasks) {
        const neighbors = adjMap2.get(node.id) || new Set();
        adjMap2.set(node.id, neighbors);
        for (const d of (node.deps || [])) {
          neighbors.add(d);
          const dn = adjMap2.get(d) || new Set();
          dn.add(node.id);
          adjMap2.set(d, dn);
        }
        for (const d of (node.context_deps || [])) {
          neighbors.add(d);
          const dn = adjMap2.get(d) || new Set();
          dn.add(node.id);
          adjMap2.set(d, dn);
        }
      }
      // Build score lookup for items in ragResults.
      const ragScoreMap = new Map();
      for (const r of ragResults) ragScoreMap.set(r.key, r.score);
      // Apply boost from neighbor scores.
      for (const r of ragResults) {
        const neighbors = adjMap2.get(r.key);
        let maxNeighborScore = 0;
        if (neighbors) {
          for (const nk of neighbors) {
            const ns = ragScoreMap.get(nk);
            if (ns !== undefined && ns > maxNeighborScore) maxNeighborScore = ns;
          }
        }
        const boost = Math.round(0.1 * maxNeighborScore * 1000) / 1000;
        r.structBoost = boost;
        r.score = Math.round((r.score + boost) * 1000) / 1000;
      }
      ragResults.sort((a, b) => b.score - a.score);
    }
    // CORROBORATION FILTER: drop RAG-tier note results that have not yet appeared in at least
    // CORROBORATION_MIN resolved task journals. Brand-new notes have zero signal and must not
    // pollute context before they have been independently corroborated. DAG-tier notes always
    // bypass this (they are injected from explicit context_deps, not from RAG). Knowledge items
    // (kind==='knowledge') are task-attached and are also exempt — only free KB notes are gated.
    if (task_key) {
      const _corrStats = recallJournal.computeNoteStats(ws);
      const _corrMin = recallJournal.CORROBORATION_MIN;
      for (let _ci = ragResults.length - 1; _ci >= 0; _ci--) {
        const _r = ragResults[_ci];
        if ((_r.kind || 'task') !== 'note') continue; // keep non-note items (tasks, knowledge)
        if (!recallJournal.isCorroborated(_r.key, _corrStats)) {
          ragResults.splice(_ci, 1);
        }
      }
    }
    // DAG notes always prepend (bypass gate). For a fully-judged claim consult (dagOnly), the
    // auto-injected context is the judged DAG neighborhood ONLY — drop the RAG-fill tier (Judge E,
    // safe under D's ready-gate). Otherwise (no task_key, or a provisional/timed-out task whose DAG
    // is not guaranteed complete) RAG fills remaining slots up to k as before — the safe fallback.
    // search_knowledge stays a fully-functional explicit tool: an ungated/no-task_key lookup, or a
    // provisional task, gets the full RAG bundle; only the fully-judged auto-claim context is pruned.
    const results = dagOnly
      ? [...sysNotes, ...dagNotes]
      : [...sysNotes, ...dagNotes, ...ragResults].slice(0, k + dagNotes.length + sysNotes.length);
    const payload = { query: q, k, asOf: asOf || null, knownAsOf: knownAsOf || null, history, round, continue: plateauContinue(results), results };
    // RECALL-OUTCOME attribution: when a task_key is present, log which note keys made it into
    // the final injected bundle. Only note-kind results carry meaningful recall signal; tasks and
    // knowledge items are not KB notes. Append a pending row (outcome finalized at terminal status).
    if (task_key) {
      try {
        const noteKeys = results
          .filter((r) => (r.kind || 'task') === 'note' || (r.kind || 'task') === 'knowledge')
          .map((r) => r.key);
        // Determine predominant recall path: dag if any dag-tier note present, else rag.
        const via = results.some((r) => r.tier === 'dag') ? 'dag' : 'rag';
        recallJournal.appendRow(ws, { task_key, recalled_note_keys: noteKeys, outcome: 'pending', via });
      } catch { /* attribution logging must never break the search response */ }
    }
    if (!gated) {
      // SHADOW: run gate over pre-scored candidates and journal the verdict, but never enforce it.
      // Rate-limited gated calls skip the gate entirely — shadow does too (no journal row).
      // Peek at the rate-limit state without mutating it (ungated callers must not consume slots).
      const clientIpShadow = req.socket.remoteAddress || 'unknown';
      const rlEntry = gatedSearchCounts.get(clientIpShadow);
      const shadowRateLimited = rlEntry && (Date.now() - rlEntry.windowStart < 60_000) && rlEntry.count > 20;
      if (!shadowRateLimited) {
        try {
          const rs = await gateTask(gateTaskInput, gateCands, { preScored: true, via: gateVia });
          // Append verdict to gate journal — training-data flywheel for the learned gate; ungated
          // rows (gated:false) capture the production retrieval path the enforced gate never sees.
          try {
            const journalRow = JSON.stringify({
              ts: new Date().toISOString(), workspace: ws, query: q,
              task_key: task_key || null, decision: rs.decision, reason: rs.reason,
              top1: rs.top1, margin: rs.margin, gap: rs.gap, locality: rs.locality, tagOverlap: rs.tagOverlap, sharedTags: rs.sharedTags,
              topType: rs.topType, topKey: rs.topKey || null, via: rs.via,
              embedModel: EMBED_MODEL, gated: false, round: typeof round === 'number' ? round : Number(round) || 1,
              ...kbMeta, ...taskMeta,
            });
            fs.appendFileSync(path.join(ws, '.graph', 'gate-journal.jsonl'), journalRow + '\n');
          } catch { /* journal failure must not break the search response */ }
        } catch { /* shadow gate failure must not break the search response */ }
      }
      return send(res, 200, payload);
    }
    // GATED: same ranked bundle + gate annotation. DAG-tier notes always inject (bypass gate).
    for (const r0 of results) if (r0.tier === 'dag') r0.inject = true;
    const clientIp = req.socket.remoteAddress || 'unknown';
    if (checkGatedRateLimit(clientIp)) {
      return send(res, 200, { ...payload, gated: true, decision: 'abstain', reason: 'rate-limited' });
    }
    // Four-guard decision over the pre-scored note-only pool (calibration-identical to the old path).
    const r = await gateTask(gateTaskInput, gateCands, { preScored: true, via: gateVia });
    // Append every verdict (inject AND abstain) to the gate journal — training-data flywheel for
    // the learned gate; abstain rows are essential for false-negative mining.
    try {
      const journalRow = JSON.stringify({
        ts: new Date().toISOString(), workspace: ws, query: q,
        task_key: task_key || null, decision: r.decision, reason: r.reason,
        top1: r.top1, margin: r.margin, gap: r.gap, locality: r.locality, tagOverlap: r.tagOverlap, sharedTags: r.sharedTags,
        topType: r.topType, topKey: r.topKey || null, via: r.via,
        embedModel: EMBED_MODEL, gated: true, round: typeof round === 'number' ? round : Number(round) || 1,
        ...kbMeta, ...taskMeta,
      });
      fs.appendFileSync(path.join(ws, '.graph', 'gate-journal.jsonl'), journalRow + '\n');
    } catch { /* journal failure must not break the search response */ }
    const meta = { gated: true, decision: r.decision, reason: r.reason, top1: r.top1, margin: r.margin, gap: r.gap, locality: r.locality, topType: r.topType, via: r.via };
    if (r.decision === 'inject' && r.topKey) {
      // Flag the approved note in the bundle; if reranking pushed it below the top-k cut, append it.
      let hit = results.find((x) => x.key === r.topKey);
      if (!hit) {
        hit = ragResults.find((x) => x.key === r.topKey);
        if (hit) results.push(hit);
      }
      if (hit) hit.inject = true;
    }
    return send(res, 200, { ...payload, ...meta });
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
