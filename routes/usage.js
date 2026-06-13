'use strict';
const { runUsageReconcile } = require('../lib/usage-reconcile');

module.exports = (ctx) => async (p, m, req, res, u, body) => {
  const { send, readBody } = ctx;

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
