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
  const currentSnapshot = T.ov.usage_reconcile_snapshot || {};
  const reports = usageAccounting.snapshotReports(currentSnapshot);
  const previousReport = reports[harnessName] || null;
  const canMergeIncrementally = usage.incrementalSessionSnapshots === true
    && usageAccounting.detailedSessionReport(previousReport);
  const nextReport = usage.reconcile(T.ws, {
    since: canMergeIncrementally ? (prev.at || null) : null,
    session: session || null,
  });
  const report = canMergeIncrementally
    ? usageAccounting.mergeCumulativeSessionReport(previousReport, nextReport)
    : nextReport;
  reports[harnessName] = report;
  const aggregate = usageAccounting.aggregateUsageReports(reports);
  const at = now();
  T.ov.usage_reconcile[harnessName] = { at, session: session || null };
  T.ov.usage_reconcile_snapshot = {
    ...currentSnapshot,
    ...reports,
    reports,
    at,
    last_harness: harnessName,
    harnesses: aggregate.harnesses,
    harness: aggregate.harnesses.length > 1 ? 'mixed' : (aggregate.harnesses[0] || harnessName),
    totals: aggregate.totals,
    cost: aggregate.cost,
    human: aggregate.human,
    sessions: aggregate.sessions,
  };
  T.save();
  notifyChange();
  return { ok: true, harness: harnessName, at, report };
}

module.exports = { runUsageReconcile, resolveHarnessName };
