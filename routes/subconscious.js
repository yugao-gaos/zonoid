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
