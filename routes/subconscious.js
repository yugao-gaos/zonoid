'use strict';

const { defaultSubconsciousStore } = require('../lib/subconscious');

module.exports = (ctx) => async (p, m, req, res, u) => {
  const { send, readBody, targetOverlay } = ctx;
  const store = ctx.subconscious || defaultSubconsciousStore;

  if (p === '/subconscious/loop' && m === 'GET') {
    const T = targetOverlay(null, u);
    const result = store.readLoopState({
      workspace: T.ws || (u && u.searchParams.get('workspace')),
      loop_id: u && u.searchParams.get('loop_id'),
      agent_id: u && u.searchParams.get('agent_id'),
      limit: u && u.searchParams.get('limit'),
    });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/loop' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.upsertLoopState({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/loop/observation' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.recordLoopObservation({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/session-companion' && m === 'GET') {
    const T = targetOverlay(null, u);
    const result = store.readSessionCompanion({
      workspace: T.ws || (u && u.searchParams.get('workspace')),
      session_id: u && u.searchParams.get('session_id'),
      limit: u && u.searchParams.get('limit'),
    });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/session-companion' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.upsertSessionCompanion({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/session-companion/observation' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.recordSessionCompanionObservation({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/anchor' && m === 'GET') {
    const T = targetOverlay(null, u);
    const result = store.readAnchorAllocation({
      workspace: T.ws || (u && u.searchParams.get('workspace')),
      session_id: u && u.searchParams.get('session_id'),
      companion_agent_id: u && u.searchParams.get('companion_agent_id'),
      companion_loop_id: u && u.searchParams.get('companion_loop_id'),
      limit: u && u.searchParams.get('limit'),
      decision_limit: u && u.searchParams.get('decision_limit'),
    });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/anchor' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.upsertAnchorAllocation({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/anchor/observation' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.recordAnchorObservation({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/anchor/decision' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.recordAnchorDecision({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/idea-scheduler' && m === 'GET') {
    const T = targetOverlay(null, u);
    const result = store.readIdeas({
      workspace: T.ws || (u && u.searchParams.get('workspace')),
      agent_id: u && u.searchParams.get('agent_id'),
      session_id: u && u.searchParams.get('session_id'),
      companion_agent_id: u && u.searchParams.get('companion_agent_id'),
      companion_loop_id: u && u.searchParams.get('companion_loop_id'),
      task_key: u && u.searchParams.get('task_key'),
      limit: u && u.searchParams.get('limit'),
    });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/idea-scheduler' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.scheduleIdea({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/event' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.recordEvent({ ...b, workspace: T.ws || b.workspace });
    if (!result.ok) { send(res, result.status || 400, { ok: false, error: result.error }); return true; }
    send(res, 200, {
      ok: true,
      workspace: result.event.workspace,
      agent_id: result.event.agent_id,
      event: result.event,
      recent_agent_events: result.recent_agent_events,
    });
    return true;
  }

  if (p === '/subconscious/ask' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = await store.ask(ctx, { ...b, workspace: T.ws || b.workspace }, req);
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  return false;
};
