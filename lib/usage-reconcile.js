'use strict';
const usageAccounting = require('./usage-accounting');

function resolveHarnessName(harnessRegistry, name) {
  if (!name) return 'claude';
  try { return harnessRegistry.get(name).name; } catch { return 'claude'; }
}

function runUsageReconcile(ctx, { harness, workspace, session, force }) {
  const { harnessRegistry, targetOverlay, now, notifyChange } = ctx;
  const harnessName = resolveHarnessName(harnessRegistry, harness || 'claude');
  const adapter = harnessRegistry.get(harnessName);
  const usage = adapter.usage;
  if (!usage || typeof usage.reconcile !== 'function') {
    return { ok: false, error: `harness '${harnessName}' has no usage.reconcile` };
  }
  const T = targetOverlay({ workspace }, null);
  if (!T.ws) return { ok: false, error: 'no workspace set' };
  if (!T.ov.usage_reconcile) T.ov.usage_reconcile = {};
  const prev = T.ov.usage_reconcile[harnessName] || {};
  const staleMs = (T.ov.config && T.ov.config.usage_reconcile_stale_hours != null)
    ? Number(T.ov.config.usage_reconcile_stale_hours) * 3600 * 1000
    : usageAccounting.DEFAULT_RECONCILE_STALE_MS;
  if (!force && !usageAccounting.reconcileStale(prev.at, staleMs)) {
    return { ok: true, skipped: true, harness: harnessName, at: prev.at, reason: 'fresh' };
  }
  const report = usage.reconcile(T.ws, { since: prev.at || null, session: session || null });
  const at = now();
  T.ov.usage_reconcile[harnessName] = { at, session: session || null };
  T.ov.usage_reconcile_snapshot = {
    ...(T.ov.usage_reconcile_snapshot || {}),
    [harnessName]: report,
    at,
    harness: harnessName,
    totals: report.totals || null,
    human: report.human || null,
    sessions: report.sessions || [],
  };
  T.save();
  notifyChange();
  return { ok: true, harness: harnessName, at, report };
}

module.exports = { runUsageReconcile, resolveHarnessName };
