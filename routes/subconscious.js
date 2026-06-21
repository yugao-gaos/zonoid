'use strict';

const { defaultSubconsciousStore } = require('../lib/subconscious');

module.exports = (ctx) => async (p, m, req, res, u) => {
  const { send, readBody, targetOverlay } = ctx;
  const store = ctx.subconscious || defaultSubconsciousStore;

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
