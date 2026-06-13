'use strict';
const { runUsageReconcile } = require('../lib/usage-reconcile');
const usageAccounting = require('../lib/usage-accounting');
const { resolveDispatcherAttribution } = require('../lib/dispatcher-attribution');

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody, notifyChange, targetOverlay } = ctx;

  if (p === '/usage/dispatcher-edit' && m === 'POST') {
    const b = await readBody(req);
    const parentSession = b.parent_session || b.session_id || null;
    if (!parentSession) {
      send(res, 400, { ok: false, error: 'parent_session required' });
      return true;
    }
    const resolved = resolveDispatcherAttribution(parentSession, ctx, b.task_key || null);
    if (!resolved.ok) {
      send(res, 409, { ok: false, ...resolved });
      return true;
    }
    const T = targetOverlay(b, u);
    const slice = usageAccounting.recordDispatcherEdit(T.ov, {
      agent_id: resolved.agent_id,
      task_key: resolved.task_key,
      chars: b.chars,
      file: b.file || null,
      parent_session: parentSession,
    });
    T.save();
    notifyChange();
    send(res, 200, { ok: true, task_key: resolved.task_key, agent_id: resolved.agent_id, slice });
    return true;
  }

  if (p === '/usage/reconcile' && m === 'POST') {
    const b = await readBody(req);
    if (!b.harness) { send(res, 400, { ok: false, error: 'harness required' }); return true; }
    const result = runUsageReconcile(ctx, {
      harness: b.harness,
      workspace: b.workspace,
      session: b.session || b.session_id,
      force: !!b.force,
    });
    const code = result.ok ? 200 : 400;
    send(res, code, result);
    return true;
  }

  return false;
};
