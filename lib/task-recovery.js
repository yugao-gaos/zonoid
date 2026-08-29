'use strict';

const overlayStore = require('./overlay');

const DEFAULT_AUTO_RETRIES = 1;

function taskKey(task) {
  return task && (task.id || task.key) ? String(task.id || task.key) : null;
}

function taskStatus(task) {
  return String(task && task.status || '').toLowerCase();
}

function normalizedStatus(value) {
  const status = String(value || '').toLowerCase();
  if (status === 'completed') return 'done';
  if (status === 'cancelled') return 'canceled';
  return status;
}

const TERMINAL_STATUSES = new Set(['done', 'failed', 'canceled']);

function reviewRecord(overlay, key) {
  return (overlay.reviews && overlay.reviews[key]) || null;
}

// Resolve contradictory sources without guessing intent. A landed merge is absorbing; otherwise
// an explicit terminal status wins. Only then may terminal review evidence repair a stale native
// pending/ready/tested row. Pending review metadata cannot reopen an explicit terminal outcome.
function operationalStatus(overlay, key, projectedStatus) {
  if (mergedEvidence(overlay, key)) return 'done';
  const explicit = normalizedStatus(overlay.status && overlay.status[key]);
  if (TERMINAL_STATUSES.has(explicit)) return explicit;
  return overlayStore.lifecycleDerivedStatus(overlay, key) || normalizedStatus(projectedStatus);
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
  if (!overlay.snapshots || !overlay.snapshots[key]) return false;
  if (normalizedStatus(overlay.snapshots[key].status) === normalizedStatus(status)) return false;
  overlayStore.setSnapshot(overlay, key, { ...overlay.snapshots[key], status });
  return true;
}

function normalizeReviewLifecycle(overlay, key, status) {
  const existing = reviewRecord(overlay, key);
  if (!existing) return false;
  const merged = mergedEvidence(overlay, key);
  const patch = status === 'done'
    ? { review_state: 'landed', review_verdict: 'APPROVE', merge_state: merged ? 'merged' : 'closed' }
    : status === 'canceled'
      ? { review_state: 'canceled', review_verdict: null, merge_state: merged ? 'merged' : 'closed' }
      : { review_state: 'rejected', review_verdict: 'KICK_BACK', merge_state: merged ? 'merged' : 'blocked' };
  if (Object.entries(patch).every(([field, value]) => (existing[field] ?? null) === value)) return false;
  overlayStore.setReviewLifecycle(overlay, key, patch);
  return true;
}

function settleTaskDecision(overlay, key, action) {
  if (!overlay.judgedTaskDecisions) overlay.judgedTaskDecisions = {};
  const id = `decision:${action}:${key}`;
  if (overlay.judgedTaskDecisions[id]) return false;
  overlay.judgedTaskDecisions[id] = true;
  return true;
}

function normalizeTerminalStatus(overlay, key, status, opts) {
  let changed = false;
  if (normalizedStatus(overlay.status && overlay.status[key]) !== status) {
    overlayStore.setStatus(overlay, key, status);
    if (typeof opts.writeTaskStatus === 'function') opts.writeTaskStatus(key, status);
    changed = true;
  }
  if (updateSnapshotStatus(overlay, key, status)) changed = true;
  if (normalizeReviewLifecycle(overlay, key, status)) changed = true;
  if (settleTaskDecision(overlay, key, 'review')) changed = true;
  if (settleTaskDecision(overlay, key, 'merge')) changed = true;
  if (status === 'canceled' && settleTaskDecision(overlay, key, 'cancel')) changed = true;
  if (status === 'failed' && settleTaskDecision(overlay, key, 'kick_back')) changed = true;
  return changed;
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
    const projectedStatus = taskStatus(task);
    const status = operationalStatus(overlay, key, projectedStatus);
    const lifecycleRecord = reviewRecord(overlay, key);
    const explicitStatus = normalizedStatus(overlay.status && overlay.status[key]);

    const landed = mergedEvidence(overlay, key)
      || (lifecycleRecord && String(lifecycleRecord.review_state || '').toLowerCase() === 'landed');
    if (status === 'done' && (landed || normalizedStatus(overlay.status && overlay.status[key]) === 'done')) {
      if (normalizeTerminalStatus(overlay, key, 'done', opts)) {
        if (!overlay.notes[key]) {
          overlay.notes[key] = mergedEvidence(overlay, key)
            ? 'auto-reconciled: landed merge evidence is authoritative'
            : 'auto-reconciled: landed review lifecycle is authoritative';
        }
        actions.push({ task_key: key, action: mergedEvidence(overlay, key) ? 'normalize_merged' : 'normalize_landed' });
      }
      continue;
    }

    const replacement = supersedeTarget(overlay, key);
    if (replacement) {
      let changed = false;
      if (status !== 'canceled') {
        overlayStore.setStatus(overlay, key, 'canceled', `auto-reconciled: superseded by ${replacement}`);
        overlayStore.applyLifecycleEvent(overlay, key, 'status_canceled', { task_status: status });
        if (typeof opts.writeTaskStatus === 'function') opts.writeTaskStatus(key, 'canceled');
        changed = true;
      }
      if (normalizeTerminalStatus(overlay, key, 'canceled', opts)) changed = true;
      if (changed) {
        actions.push({ task_key: key, action: 'normalize_superseded', replacement });
      }
      continue;
    }

    const canceled = status === 'canceled' && (lifecycleRecord
      || normalizedStatus(overlay.status && overlay.status[key]) === 'canceled');
    if (canceled) {
      if (normalizeTerminalStatus(overlay, key, 'canceled', opts)) {
        actions.push({ task_key: key, action: 'normalize_canceled' });
      }
      continue;
    }

    // An explicit failed status is a settled task outcome, not an invitation for stale rejection
    // or merge-blocked metadata to reopen the row. Lifecycle-derived failure on a genuinely
    // nonterminal row continues through the bounded retry path below.
    if (status === 'failed' && explicitStatus === 'failed') {
      const changed = normalizeTerminalStatus(overlay, key, 'failed', opts);
      const explicitlyBlocked = !!(overlay.blocked && overlay.blocked[key]);
      const guidance = explicitlyBlocked
        ? recoveryGuidance(overlay, task, key, Number(retryRecord(overlay, key).retryCount) || 0, dependentsOf(key))
        : { created: false };
      if (guidance.created) actions.push({ task_key: key, action: 'needs_guidance', guidance_id: guidance.id });
      else if (changed) actions.push({ task_key: key, action: 'normalize_failed' });
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

    const normalizedFailure = normalizeTerminalStatus(overlay, key, 'failed', opts);
    const guidance = recoveryGuidance(overlay, task, key, retryCount, dependentsOf(key));
    if (guidance.created) actions.push({ task_key: key, action: 'needs_guidance', guidance_id: guidance.id });
    else if (normalizedFailure) actions.push({ task_key: key, action: 'settle_failed_lifecycle' });
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
