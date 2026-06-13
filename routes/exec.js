'use strict';
const crypto = require('crypto');

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, notifyChange, targetOverlay, now, loops, saveLoops, saveAgents,
    agentsArr, releaseClaim, newLoop, decideAll, LOOP_CONFIG_KEYS, usageCached,
    MAX_ROUTES, state } = ctx;

  if (p === '/loop/start' && m === 'POST') {
    const b = await readBody(req);
    // Accept a caller-supplied loopId (idempotent restart) or mint one. If it already exists we
    // RESET that entry in place rather than refusing — but we never overwrite a DIFFERENT loop.
    const loopId = (b.loopId && String(b.loopId)) || crypto.randomUUID();
    const L = newLoop({ id: loopId });
    L.active = true; L.startedAt = now(); L.lastProgress = now();
    L.session = b.session || null;   // the conversation driving this loop — addresses its cooperative-stop signal
    // Workspace PIN (captured once, persists via loops.json): the heartbeat decides this loop
    // against THIS workspace's graph even if another session later flips the daemon-global
    // state.workspace. mcp-core injects the calling session's pin into every POST body; a bare
    // caller pins to the global workspace as of NOW. null (legacy entries) ⇒ dynamic global fallback.
    L.workspace = b.workspace || state.workspace || null;
    L.real = !!state.mainTranscript;
    L.baseline = state.mainTranscript ? (usageCached(state.mainTranscript).total || 0) : 0;
    for (const k of LOOP_CONFIG_KEYS) if (b[k] != null) L.config[k] = b[k];
    loops.set(loopId, L);
    saveLoops();
    return send(res, 200, { ok: true, loopId, loop: L });
  }
  if (p === '/loop/stop' && m === 'POST') {
    const b = await readBody(req);
    const loopId = b.loopId || u.searchParams.get('loopId');
    if (!loopId) return send(res, 400, { ok: false, error: 'loopId required' });
    const L = loops.get(loopId);
    if (!L) return send(res, 404, { ok: false, error: 'unknown loopId', loopId });
    L.active = false; saveLoops();
    return send(res, 200, { ok: true, loopId });
  }
  if (p === '/loop/status') {
    const loopId = u.searchParams.get('loopId');
    if (loopId) {
      const L = loops.get(loopId);
      if (!L) return send(res, 404, { ok: false, error: 'unknown loopId', loopId });
      return send(res, 200, L);
    }
    return send(res, 200, { loops: Object.fromEntries(loops) });
  }
  if (p === '/next-action') { const r = decideAll(); saveLoops(); return send(res, 200, { loops: r }); }

  if (p === '/route' && m === 'POST') {
    const b = await readBody(req);
    state.routes.push({ ts: now(), prompt: String(b.prompt || '').slice(0, 280), decision: b.decision || 'solo', reason: String(b.reason || '').slice(0, 280) });
    if (state.routes.length > MAX_ROUTES) state.routes.shift();
    return send(res, 200, { ok: true });
  }

  if (p === '/agent/start' && m === 'POST') {
    const b = await readBody(req);
    if (!b.agent_id) return send(res, 400, { ok: false, error: 'agent_id required' });
    const prev = state.agents[b.agent_id] || {};
    // Capture task/session/workspace so a colliding worker is visible across sessions (GET /agents).
    state.agents[b.agent_id] = { agent_id: b.agent_id, agent_type: b.agent_type || prev.agent_type || 'agent', state: 'running', transcript_path: b.transcript_path || prev.transcript_path || null, task: b.task || prev.task || null, session: b.session || prev.session || null, subagent_session: b.subagent_session || prev.subagent_session || null, workspace: b.workspace || prev.workspace || state.workspace || null, startedAt: prev.startedAt || now(), lastSeen: now(), endedAt: null };
    saveAgents();
    notifyChange();
    return send(res, 200, { ok: true });
  }
  if (p === '/agent/done' && m === 'POST') {
    const b = await readBody(req);
    const a = state.agents[b.agent_id];
    if (!a) return send(res, 404, { ok: false, error: 'unknown agent' });
    a.state = 'done'; a.endedAt = now(); a.lastSeen = now();
    // Cascade: release any in_progress task this agent still holds (it stopped without completing),
    // so the claim doesn't linger as a phantom in_progress. Fixes the stale-status bug directly.
    // Target the AGENT'S workspace (recorded at /agent/start), not the daemon-global overlay —
    // the claim lives where the agent's session was pinned (read-side gremlin fix).
    const T = targetOverlay({ workspace: b.workspace || a.workspace }, u);
    let released = 0;
    for (const [key, st] of Object.entries(T.ov.status))
      if (st === 'in_progress' && T.ov.assignee[key] === b.agent_id
          && releaseClaim(key, `auto-released: agent '${b.agent_id}' stopped without completing`, T.ov, null, T.ws)) released++;
    if (released) T.save();
    saveAgents();
    notifyChange();
    return send(res, 200, { ok: true, released });
  }

  // Cross-session visibility: list every known agent with task/session/workspace/startedAt and
  // its current cooperative-stop flag, so one session can SEE a worker running in another.
  if (p === '/agents') {
    const ovStops = targetOverlay(null, u).ov;   // stop flags live per-workspace; honor ?workspace=
    const list = agentsArr().map((a) => ({
      agent_id: a.agent_id, agent_type: a.agent_type, state: a.state,
      task: a.task || null, session: a.session || null, workspace: a.workspace || null,
      startedAt: a.startedAt || null, endedAt: a.endedAt || null,
      stop_requested: ovStops.stop_requested[a.agent_id] || null,
    }));
    return send(res, 200, { agents: list });
  }

  // Cooperative stop: raise an advisory stop flag for a worker (by agent_id, or by task_key via
  // its assignee). No cross-process kill — the worker is expected to poll /agents (or
  // /agent/stop-requested) and self-terminate. Returns the resolved agent or 404.
  if (p === '/agent/stop' && m === 'POST') {
    const b = await readBody(req);
    const T = targetOverlay(b, u);   // flag lands in the CALLER's workspace overlay
    let agentId = b.agent_id || null;
    if (!agentId && b.task_key) agentId = T.ov.assignee[b.task_key] || agentsArr().find((a) => a.task === b.task_key)?.agent_id || null;
    if (!agentId) return send(res, 404, { ok: false, error: 'no agent for that agent_id/task_key' });
    T.ov.stop_requested[agentId] = now();
    T.save();
    notifyChange();
    return send(res, 200, { ok: true, agent_id: agentId, stop_requested: T.ov.stop_requested[agentId] });
  }
  // A worker polls this to learn whether it should cooperatively stop.
  if (p === '/agent/stop-requested') {
    const id = u.searchParams.get('agent_id');
    if (!id) return send(res, 400, { ok: false, error: 'agent_id required' });
    return send(res, 200, { agent_id: id, stop_requested: targetOverlay(null, u).ov.stop_requested[id] || null });
  }

  return false;
};
