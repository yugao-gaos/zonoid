'use strict';
const crypto = require('crypto');
const { resolveHarnessName } = require('../lib/usage-reconcile');
const usageAccounting = require('../lib/usage-accounting');

function resolveHarnessForAgent(ctx, agent, body) {
  if (body.harness) return resolveHarnessName(ctx.harnessRegistry, body.harness);
  if (agent && agent.session && ctx.state.sessions && ctx.state.sessions[agent.session]) {
    return resolveHarnessName(ctx.harnessRegistry, ctx.state.sessions[agent.session].harness);
  }
  return 'claude';
}

function linkTaskKeyForAgent(ov, agentId) {
  for (const [key, st] of Object.entries(ov.status || {})) {
    if (st === 'in_progress' && ov.assignee[key] === agentId) return key;
  }
  for (const [key, aid] of Object.entries(ov.assignee || {})) {
    if (aid === agentId) return key;
  }
  return null;
}

function recordUsageOnDone(ctx, T, agent, body) {
  const harnessName = resolveHarnessForAgent(ctx, agent, body);
  const adapter = ctx.harnessRegistry.get(harnessName);
  const usageApi = adapter.usage;
  if (!usageApi) return null;
  const endedAt = ctx.now();
  const startedAt = agent.startedAt || null;
  const window = { start: startedAt, end: endedAt };
  const baseCtx = {
    agent_id: body.agent_id,
    session_id: agent.session || body.session || null,
    transcript_path: agent.transcript_path || body.transcript_path || null,
    task_key: linkTaskKeyForAgent(T.ov, body.agent_id),
    startedAt,
    endedAt,
    window,
    reported_usage: body.reported_usage,
    baseline: agent.usage_baseline || null,
  };
  let slice = null;
  const tp = baseCtx.transcript_path;
  if (tp && typeof usageApi.sample === 'function') {
    slice = usageApi.sample(tp, baseCtx);
  } else if (body.reported_usage && typeof usageApi.normalizeReported === 'function') {
    slice = usageApi.normalizeReported(body.reported_usage, baseCtx);
  }
  if (!slice) return null;
  if (!slice.task_key) slice.task_key = baseCtx.task_key;
  // Dollar overlay (CDX-3): ensure the slice carries cost.usd before it lands in usage_records.
  // Pricing stays ADAPTER-OWNED — the daemon only INVOKES adapter.price(slice) (which reads
  // pricing.json and multiplies per-model token counts); it never embeds rates. Adapters that
  // already priced at normalize time are re-priced idempotently (same rates → same numbers). The
  // daemon's own rollups (sumUsageRecords / recordTaskCost) only SUM the resulting cost.usd.
  if (typeof usageApi.price === 'function') {
    try { usageApi.price(slice); } catch { /* pricing must never block usage recording */ }
  }
  // Node-scoped eager judge attribution: when the completing agent was dispatched for a specific
  // node (judged_node set at /agent/start), stamp the node key on the slice so the per-node
  // judging-cost rollup can sum it. Non-node-scoped drains have no judged_node and stay pooled
  // on the harness-judge-drain task_key. The existing task_key attribution is unchanged.
  const judgedNode = agent.judged_node || null;
  if (judgedNode) slice.judged_node = judgedNode;
  // Explicit role tag: a judge dispatched against an attempt branch (orch/attempt/<key>) is review
  // work even without judged_node. The dispatcher may also set body.role directly. roleForSlice
  // reads this; we stamp it onto the slice so it survives into both rollups.
  if (body.role === 'review' || body.role === 'implementation') slice.role = body.role;
  else if (agent.role === 'review' || agent.role === 'implementation') slice.role = agent.role;
  if (!T.ov.usage_records) T.ov.usage_records = {};
  T.ov.usage_records[body.agent_id] = slice;
  // Rework-aware accumulation: append this agent-run finish (worker OR judge) to the per-task
  // rollup, role-tagged impl|review, so multiple attempts on one task SUM instead of overwriting.
  // Fires on EVERY /agent/done (kicked-back worker re-runs and judge runs each hit this path),
  // which is exactly the "report on agent-run finish, not just terminal complete_task" requirement.
  if (slice.task_key) usageAccounting.recordTaskCost(T.ov, slice);
  return slice;
}

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, notifyChange, targetOverlay, now, loops, saveLoops,
    agentsArr, releaseClaim, newLoop, decideAll, LOOP_CONFIG_KEYS, usageCached,
    touchAgent, bindSession, mainTranscriptForSession, MAX_ROUTES, state, harnessRegistry } = ctx;

  if (p === '/loop/start' && m === 'POST') {
    const b = await readBody(req);
    // Dedupe (registry-leak guard, task /3): if this session already drives a LIVE loop, reuse it
    // instead of minting a fresh UUID. Without this, every heartbeat "no active loop" nudge piles up
    // a new born-dead entry (153 accrued by 2026-06-15). An explicit caller-supplied loopId (restart)
    // bypasses dedupe and resets that specific entry in place.
    if (!b.loopId && b.session) {
      for (const [id, ex] of loops) {
        if (ex.active && ex.session === b.session) {
          ex.lastProgress = now();
          for (const k of LOOP_CONFIG_KEYS) if (b[k] != null) ex.config[k] = b[k];
          saveLoops();
          return send(res, 200, { ok: true, loopId: id, loop: ex, reused: true });
        }
      }
    }
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
    const loopSession = b.session || null;
    let mainTx = loopSession ? mainTranscriptForSession(loopSession) : null;
    if (!mainTx && state.sessions) {
      const ids = Object.keys(state.sessions);
      if (ids.length === 1) mainTx = mainTranscriptForSession(ids[0]);
    }
    L.real = !!mainTx;
    L.baseline = mainTx ? (usageCached(mainTx).total || 0) : 0;
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
    const harnessName = resolveHarnessForAgent(ctx, null, b);
    const adapter = harnessRegistry.get(harnessName);
    let usageBaseline = null;
    if (b.transcript_path && adapter.usage && adapter.usage.sample) {
      try {
        const baselineSlice = adapter.usage.sample(b.transcript_path, {
          agent_id: b.agent_id,
          session_id: b.session || b.session_id,
          transcript_path: b.transcript_path,
          window: { end: now() },
        });
        usageBaseline = baselineSlice && baselineSlice.usage ? baselineSlice.usage : null;
      } catch { /* optional baseline */ }
    }
    const parentSession = b.session || b.session_id || null;
    let subagentSession = b.subagent_session || null;
    if (subagentSession && parentSession && subagentSession === parentSession) subagentSession = null;
    // Agent-tool spawn detection — unified at this single /agent/start chokepoint. Two registration
    // signals collapse into ONE normalized field: (a) the SubagentStart hook POSTs an explicit
    // agent_tool_spawn:true (background spawns reuse .output paths, so session extraction is
    // unreliable and the hook flags the spawn mode directly); (b) a parent_session_id-bearing caller
    // whose parent equals its session. Honoring both makes the explicit hook flag authoritative.
    const agentToolSpawn = b.agent_tool_spawn === true || !!(b.parent_session_id && b.parent_session_id === parentSession);
    // Capture task/session/workspace so a colliding worker is visible across sessions (GET /agents).
    // judged_node: set when this is a node-scoped eager judge dispatch (GET /judge/next?node=<key>)
    // so the completing agent's usage slice can be attributed to the triggering node.
    touchAgent(b.agent_id, { state: 'running', agent_type: b.agent_type, transcript_path: b.transcript_path, task: b.task, task_key: b.task_key, session: b.session, subagent_session: subagentSession, agent_tool_spawn: agentToolSpawn, workspace: b.workspace || state.workspace, reported_usage: b.reported_usage, usage_baseline: usageBaseline, judged_node: b.judged_node || null });
    const sessionId = b.session || b.session_id || b.conversation_id;
    if (sessionId && b.transcript_path) {
      bindSession(sessionId, { transcript: b.transcript_path, workspace: b.workspace || state.workspace, harness: b.harness });
    }
    notifyChange();
    return send(res, 200, { ok: true });
  }
  if (p === '/agent/done' && m === 'POST') {
    const b = await readBody(req);
    const a = state.agents[b.agent_id];
    if (!a) return send(res, 404, { ok: false, error: 'unknown agent' });
    const T = targetOverlay({ workspace: b.workspace || a.workspace }, u);
    const usageSlice = recordUsageOnDone(ctx, T, a, b);
    touchAgent(b.agent_id, { state: 'done', reported_usage: b.reported_usage });
    // Cascade: release any in_progress task this agent still holds (it stopped without completing),
    // so the claim doesn't linger as a phantom in_progress. Fixes the stale-status bug directly.
    // Target the AGENT'S workspace (recorded at /agent/start), not the daemon-global overlay —
    // the claim lives where the agent's session was pinned (read-side gremlin fix).
    let released = 0;
    for (const [key, st] of Object.entries(T.ov.status))
      if (st === 'in_progress' && T.ov.assignee[key] === b.agent_id
          && releaseClaim(key, `auto-released: agent '${b.agent_id}' stopped without completing`, T.ov, null, T.ws)) released++;
    if (usageSlice || released) T.save();
    notifyChange();
    return send(res, 200, { ok: true, released, usage: usageSlice ? { agent_id: b.agent_id, task_key: usageSlice.task_key || null } : null });
  }

  // Cross-session visibility: list every known agent with task/session/workspace/startedAt and
  // its current cooperative-stop flag, so one session can SEE a worker running in another.
  if (p === '/agents') {
    const ovStops = targetOverlay(null, u).ov;   // stop flags live per-workspace; honor ?workspace=
    const wsFilter = u.searchParams.get('workspace') || null;
    const all = agentsArr();
    const filtered = wsFilter ? all.filter((a) => a.workspace === wsFilter) : all;
    const list = filtered.map((a) => ({
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
