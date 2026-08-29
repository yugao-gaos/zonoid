'use strict';

const overlayStore = require('./overlay');

const DEFAULT_AUTO_RETRIES = 1;

function taskKey(task) {
  return task && (task.id || task.key) ? String(task.id || task.key) : null;
}

function taskStatus(task) {
  return String(task && task.status || '').toLowerCase();
}

function mergedEvidence(overlay, key) {
  const git = overlay.git && overlay.git[key];
  const review = overlay.reviews && overlay.reviews[key];
  return !!((git && git.merged) || (review && review.merge_state === 'merged'));
}

function supersedeTarget(overlay, key) {
  const targets = [...new Set((overlay.edges || [])
    .filter((edge) => edge && edge.kind === 'supersede' && edge.from === key && !edge.fromWorkspace && !edge.toWorkspace)
    .map((edge) => edge.to)
    .filter(Boolean))];
  return targets.length === 1 ? targets[0] : null;
}

function dependencyStatus(overlay, key, statusFor, seen = new Set()) {
  if (seen.has(key)) return 'not_ready';
  const status = statusFor(key);
  if (status !== 'canceled') return status;
  const replacement = supersedeTarget(overlay, key);
  if (!replacement) return status;
  const nextSeen = new Set(seen); nextSeen.add(key);
  return dependencyStatus(overlay, replacement, statusFor, nextSeen);
}

function retryRecord(overlay, key) {
  if (!overlay.retryConfig) overlay.retryConfig = {};
  if (!overlay.retryConfig[key]) overlay.retryConfig[key] = {};
  return overlay.retryConfig[key];
}

function retryLimit(overlay, key) {
  const record = retryRecord(overlay, key);
  const explicit = Number(record.maxRetries);
  if (Number.isFinite(explicit) && explicit >= 0) return explicit;
  const configured = Number(overlay.config && overlay.config.auto_retry_limit);
  if (Number.isFinite(configured) && configured >= 0) return configured;
  return DEFAULT_AUTO_RETRIES;
}

function updateSnapshotStatus(overlay, key, status) {
  if (!overlay.snapshots || !overlay.snapshots[key]) return;
  overlayStore.setSnapshot(overlay, key, { ...overlay.snapshots[key], status });
}

function recoveryGuidance(overlay, task, key, retryCount, dependents) {
  const existing = (overlay.guidance || []).find((item) => !item.resolved
    && item.action && item.action.kind === 'task-recovery'
    && (item.action.task_key || item.action.taskKey) === key);
  if (existing) return { id: existing.id, created: false };
  const label = task.label || key;
  const review = overlay.reviews && overlay.reviews[key];
  const reason = review && (review.review_reason || review.review_note);
  const affected = dependents.length
    ? `\nAffected dependents: ${dependents.join(', ')}`
    : '\nAffected dependents: none';
  return { id: overlayStore.addGuidance(overlay, {
    question: `Task "${label}" needs a recovery decision after ${retryCount} automatic ${retryCount === 1 ? 'retry' : 'retries'}.`,
    context: `${reason ? `Last failure: ${reason}\n` : ''}Choose Retry to start a fresh attempt, Keep blocked to preserve the failure for later, or Cancel if the work is no longer required.${affected}`,
    trigger: 'repeated_failure',
    severity: 'blocking',
    origin_task: key,
    action: {
      kind: 'task-recovery',
      task_key: key,
      recommended: 'retry',
      dependents,
    },
  }), created: true };
}

// Conservative autonomous reconciliation for terminal operational debris:
//   * landed evidence is authoritative over a stale failed/tested override;
//   * an explicit, unambiguous supersede edge retires its old task;
//   * a failure gets one bounded retry, then becomes a durable user decision.
// No task is canceled from prose, and a real blocked flag is never cleared here.
function reconcile(overlay, tasks, opts = {}) {
  const actions = [];
  // Graph projections also contain note/knowledge/entity nodes. Their projection status is their
  // kind (not canceled/done), so treating them as operational tasks would "reconcile" the same
  // superseded note on every heartbeat, save the overlay again, invalidate the graph cache, and
  // pin the daemon in a rebuild loop. Recovery is deliberately task-only.
  const allTasks = (tasks || []).filter((task) => taskKey(task) && !overlayStore.isNonTaskNode(task));
  const dependentsOf = (key) => allTasks
    .filter((task) => Array.isArray(task.deps) && task.deps.includes(key))
    .map((task) => taskKey(task));

  for (const task of allTasks) {
    const key = taskKey(task);
    const status = taskStatus(task);

    if (mergedEvidence(overlay, key)) {
      if (status !== 'done') {
        overlayStore.setStatus(overlay, key, 'done', 'auto-reconciled: landed merge evidence is authoritative');
        updateSnapshotStatus(overlay, key, 'done');
        if (typeof opts.writeTaskStatus === 'function') opts.writeTaskStatus(key, 'done');
        actions.push({ task_key: key, action: 'normalize_merged' });
      }
      continue;
    }

    const replacement = supersedeTarget(overlay, key);
    if (replacement) {
      if (status !== 'canceled') {
        overlayStore.setStatus(overlay, key, 'canceled', `auto-reconciled: superseded by ${replacement}`);
        overlayStore.applyLifecycleEvent(overlay, key, 'status_canceled', { task_status: status });
        updateSnapshotStatus(overlay, key, 'canceled');
        if (typeof opts.writeTaskStatus === 'function') opts.writeTaskStatus(key, 'canceled');
        actions.push({ task_key: key, action: 'normalize_superseded', replacement });
      }
      continue;
    }

    if (status !== 'failed') continue;
    const record = retryRecord(overlay, key);
    if (record.recoveryDecision === 'keep' || record.recoveryDecision === 'cancel') continue;
    const retryCount = Number(record.retryCount) || 0;
    const limit = retryLimit(overlay, key);
    const explicitlyBlocked = !!(overlay.blocked && overlay.blocked[key]);

    if (!explicitlyBlocked && retryCount < limit) {
      record.retryCount = retryCount + 1;
      record.lastAutoRetryAt = opts.now || new Date().toISOString();
      const previousAgent = overlay.assignee && overlay.assignee[key];
      overlayStore.applyLifecycleEvent(overlay, key, 'retry_requeue', { task_status: status });
      delete overlay.status[key];
      updateSnapshotStatus(overlay, key, 'pending');
      overlay.notes[key] = `auto-requeued after failure (${record.retryCount}/${limit})${previousAgent ? ` — prior agent: '${previousAgent}'` : ''}. Review the prior failure before changing the approach.`.slice(0, 280);
      if (typeof opts.writeTaskStatus === 'function') opts.writeTaskStatus(key, 'pending');
      actions.push({ task_key: key, action: 'retry', retry_count: record.retryCount, retry_limit: limit });
      continue;
    }

    const guidance = recoveryGuidance(overlay, task, key, retryCount, dependentsOf(key));
    if (guidance.created) actions.push({ task_key: key, action: 'needs_guidance', guidance_id: guidance.id });
  }

  return { changed: actions.length > 0, actions };
}

function resolveRecovery(overlay, action, decision) {
  const key = action && (action.task_key || action.taskKey);
  if (!key || !['retry', 'keep', 'cancel'].includes(decision)) return null;
  const record = retryRecord(overlay, key);
  record.recoveryDecision = decision;
  record.recoveryDecisionAt = new Date().toISOString();

  if (decision === 'retry') {
    overlayStore.applyLifecycleEvent(overlay, key, 'retry_requeue', { task_status: 'failed' });
    delete overlay.status[key];
    delete record.recoveryDecision;
    updateSnapshotStatus(overlay, key, 'pending');
    overlay.notes[key] = 'released by user: retry requested after automatic recovery budget was exhausted';
    return { decision, retried_task_key: key };
  }
  if (decision === 'cancel') {
    overlayStore.setStatus(overlay, key, 'canceled', 'canceled by user from Needs You recovery');
    overlayStore.applyLifecycleEvent(overlay, key, 'status_canceled', { task_status: 'failed' });
    updateSnapshotStatus(overlay, key, 'canceled');
    return { decision, canceled_task_key: key };
  }
  overlay.notes[key] = 'kept blocked by user from Needs You recovery';
  return { decision, kept_task_key: key };
}

module.exports = {
  DEFAULT_AUTO_RETRIES,
  dependencyStatus,
  mergedEvidence,
  reconcile,
  resolveRecovery,
  retryLimit,
  supersedeTarget,
};
