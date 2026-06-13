// Token cost-flow attribution ("autonomy score") over the workspace task graph.
//
// Model (conservation property — every token is counted exactly once):
//   T(n) = own_tokens(n) + Σ inherited shares from upstream contributors.
//   n passes T(n)·w/W(n) along each outgoing edge (contributor → consumer),
//   where W(n) = Σ of n's outgoing edge weights. Blocking deps weigh 1.0;
//   context edges carry their stored relevance weight (default 0.5).
//   Computed in topological order over the SCC condensation — context-edge
//   cycles collapse into one component first, so the order always exists.
//   A MERGED component is a SINK: it claims its accumulated T and passes 0
//   downstream (reuse of landed work is free/amortized). A terminal
//   non-merged component traps its T — named waste. Pass-through components
//   (non-merged, with consumers) keep nothing; their cost lands downstream.
//   Conservation: Σ results.T + Σ waste.T === Σ own (up to float error).
'use strict';

// Tarjan strongly-connected components, iterative (no recursion-depth limit).
// ids: node ids; adj: Map id -> [successor ids]. Returns array of components
// (arrays of ids) in REVERSE topological order (Tarjan's natural output).
function sccs(ids, adj) {
  const index = new Map(), low = new Map(), onStack = new Set();
  const stack = [], comps = [];
  let counter = 0;
  for (const root of ids) {
    if (index.has(root)) continue;
    // explicit DFS frames: [node, child-iterator-position]
    const frames = [[root, 0]];
    while (frames.length) {
      const frame = frames[frames.length - 1];
      const v = frame[0];
      if (frame[1] === 0) { index.set(v, counter); low.set(v, counter); counter++; stack.push(v); onStack.add(v); }
      const succ = adj.get(v) || [];
      let advanced = false;
      while (frame[1] < succ.length) {
        const w = succ[frame[1]++];
        if (!index.has(w)) { frames.push([w, 0]); advanced = true; break; }
        if (onStack.has(w)) low.set(v, Math.min(low.get(v), index.get(w)));
      }
      if (advanced) continue;
      // v is finished: pop frame, fold lowlink into parent, maybe emit a component
      frames.pop();
      if (frames.length) { const p = frames[frames.length - 1][0]; low.set(p, Math.min(low.get(p), low.get(v))); }
      if (low.get(v) === index.get(v)) {
        const comp = [];
        for (;;) { const w = stack.pop(); onStack.delete(w); comp.push(w); if (w === v) break; }
        comps.push(comp);
      }
    }
  }
  return comps;
}

// Honest per-task own-token splits. tasks: [{ id, transcript, window:{start,end} }] where
// `transcript` is the resolved usage JSONL (null = unknown) and `window` the task's claim
// window (ISO strings). usageFor(tp) -> { total } (a cached reader). Tasks sharing ONE
// transcript divide its total proportionally to claim-window duration (each window floors at
// 1ms so an instant claim still gets a share) instead of each double-counting the full session.
// Returns Map id -> own tokens (0 when the transcript is unknown/unreadable).
function splitSessionTokens(tasks, usageFor) {
  const out = new Map(tasks.map((t) => [t.id, 0]));
  const groups = new Map(); // transcript path -> [task]
  for (const t of tasks) {
    if (!t.transcript) continue;
    if (!groups.has(t.transcript)) groups.set(t.transcript, []);
    groups.get(t.transcript).push(t);
  }
  for (const [tp, members] of groups) {
    let total = 0;
    try { total = ((usageFor(tp, members[0]) || {}).total) || 0; } catch { total = 0; }
    if (!total) continue;
    const durs = members.map((t) => {
      if (t.work_sessions && t.work_sessions.length > 0) {
        const ms = t.work_sessions
          .filter((ws) => ws.end_ts)
          .reduce((sum, ws) => {
            const s = Date.parse(ws.start_ts || '');
            const e = Date.parse(ws.end_ts || '');
            return sum + (Number.isFinite(s) && Number.isFinite(e) ? Math.max(1, e - s) : 0);
          }, 0);
        if (ms > 0) return ms;
      }
      const s = Date.parse((t.window && t.window.start) || '');
      const e = Date.parse((t.window && t.window.end) || '');
      return Number.isFinite(s) && Number.isFinite(e) ? Math.max(1, e - s) : 1;
    });
    const D = durs.reduce((a, b) => a + b, 0);
    members.forEach((t, k) => out.set(t.id, total * durs[k] / D));
  }
  for (const t of tasks) {
    if (t.transcript) continue;
    let total = 0;
    try { total = ((usageFor(null, t) || {}).total) || 0; } catch { total = 0; }
    if (total) out.set(t.id, total);
  }
  return out;
}

// The flow itself. nodes: [{ id, own, merged, label? }]; edges: [{ from, to, weight }]
// (from CONTRIBUTES TO to). Unknown endpoints, self-loops and non-positive weights are
// dropped. Returns { results, waste, totals } — results: merged sinks [{ task, label,
// members, T, own, inherited }] desc by T; waste: terminal non-merged components with
// trapped T>0 [{ task, label, members, trapped }] desc; totals: { total, productive,
// trapped } where productive + trapped === total (conservation).
function computeFlow(nodes, edges) {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  const E = edges.filter((e) => byId.has(e.from) && byId.has(e.to) && e.from !== e.to && e.weight > 0);
  const adj = new Map(nodes.map((n) => [n.id, []]));
  for (const e of E) adj.get(e.from).push(e.to);

  // 1) collapse strongly-connected components (context-edge cycles) into super-nodes
  const comps = sccs([...byId.keys()], adj);
  const compOf = new Map();
  comps.forEach((members, i) => members.forEach((id) => compOf.set(id, i)));
  const C = comps.map((members, i) => ({
    i,
    members,
    own: members.reduce((s, id) => s + (byId.get(id).own || 0), 0),
    merged: members.some((id) => !!byId.get(id).merged),
    out: new Map(), // component index -> summed edge weight
  }));
  for (const e of E) {
    const a = compOf.get(e.from), b = compOf.get(e.to);
    if (a !== b) C[a].out.set(b, (C[a].out.get(b) || 0) + e.weight);
  }

  // 2) Kahn topological order over the condensation (a DAG by construction)
  const indeg = C.map(() => 0);
  for (const c of C) for (const b of c.out.keys()) indeg[b]++;
  const queue = C.filter((c) => indeg[c.i] === 0).map((c) => c.i);
  const order = [];
  while (queue.length) {
    const i = queue.shift();
    order.push(i);
    for (const b of C[i].out.keys()) if (--indeg[b] === 0) queue.push(b);
  }

  // 3) flow accumulated cost downstream; merged components are claiming sinks
  const T = C.map((c) => c.own);
  const results = [], waste = [];
  const repOf = (c) => c.members.reduce((best, id) => ((byId.get(id).own || 0) > (byId.get(best).own || 0) ? id : best), c.members[0]);
  for (const i of order) {
    const c = C[i];
    const rep = repOf(c);
    if (c.merged) { // sink: claim T, pass 0 (reuse of landed work is free)
      results.push({ task: rep, label: byId.get(rep).label || '', members: c.members, T: T[i], own: c.own, inherited: T[i] - c.own });
      continue;
    }
    const W = [...c.out.values()].reduce((s, w) => s + w, 0);
    if (W > 0) { for (const [b, w] of c.out) T[b] += T[i] * (w / W); continue; } // pass-through
    if (T[i] > 0) waste.push({ task: rep, label: byId.get(rep).label || '', members: c.members, trapped: T[i] }); // terminal trap
  }
  results.sort((a, b) => b.T - a.T);
  waste.sort((a, b) => b.trapped - a.trapped);
  const total = nodes.reduce((s, n) => s + (n.own || 0), 0);
  const productive = results.reduce((s, r) => s + r.T, 0);
  const trapped = waste.reduce((s, w) => s + w.trapped, 0);
  return { results, waste, totals: { total, productive, trapped } };
}

// Catch-all session nodes (design note-mq89ptfjx0y): one SYNTHESIZED node per main session,
// owning the session-transcript tokens NOT split to any task claim (own = total − claimed,
// floored at 0), with context edges to every graph node that session created (matched on the
// node's `session` field). Conversation tokens thus become productive only when the work they
// steered reaches a merged sink; a session with no outputs is a terminal trap — NAMED waste.
// In-memory only: these nodes exist solely inside a computeFlow run (kind:'session'), never as
// native todos or task-view entries. sessions: [{ id, total, claimed }]; tasks: [{ id, session }].
// Returns { nodes, edges } in computeFlow's input shape.
function sessionCatchalls(sessions, tasks, contextWeight = 0.5) {
  const bySession = new Map();
  for (const t of tasks) {
    if (!t.session) continue;
    if (!bySession.has(t.session)) bySession.set(t.session, []);
    bySession.get(t.session).push(t.id);
  }
  const nodes = [], edges = [];
  for (const s of sessions) {
    if (!s || !s.id) continue;
    const own = Math.max(0, (s.total || 0) - (s.claimed || 0));
    const outs = bySession.get(s.id) || [];
    if (own <= 0 && !outs.length) continue; // nothing to account for, nothing produced
    const id = `session:${s.id}`;
    nodes.push({ id, own, merged: false, kind: 'session', label: `session ${String(s.id).slice(0, 8)} (unattributed chat)` });
    for (const to of outs) edges.push({ from: id, to, weight: contextWeight });
  }
  return { nodes, edges };
}

module.exports = { computeFlow, splitSessionTokens, sessionCatchalls, sccs };
