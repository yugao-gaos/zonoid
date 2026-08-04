'use strict';

const DEFAULT_LEASE_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_TTL_MS = 10 * 60 * 1000;
const DEFAULT_REMINDER_BASE_MS = 30 * 1000;
const DEFAULT_REMINDER_MAX_MS = 30 * 60 * 1000;

const INTERNAL_ACTIONS = new Set([
  'dup-cluster', 'stale-verdict', 'stale-hold', 'force_claim_cap', 'readiness-repair',
]);

function timeMs(value) {
  const n = typeof value === 'number' ? value : Date.parse(value || '');
  return Number.isFinite(n) ? n : null;
}

function iso(nowMs) { return new Date(nowMs).toISOString(); }

function isActionable(item) {
  if (!item || item.resolved || item.severity === 'review' || item.sessionKey) return false;
  const kind = item.action && item.action.kind;
  return !kind || !INTERNAL_ACTIONS.has(kind);
}

// Existing guidance rows are upgraded only when decision delivery touches them. This keeps old
// overlays readable while making the new state durable on the next ordinary save.
function normalizeGuidance(item, nowMs = Date.now()) {
  if (!item || typeof item !== 'object') return item;
  if (!item.decision_state) item.decision_state = item.resolved ? 'resolved' : 'pending';
  if (!item.delivery || typeof item.delivery !== 'object') {
    item.delivery = {
      session_id: null,
      leased_at: null,
      lease_expires_at: null,
      last_prompt_at: null,
      next_prompt_at: null,
      reminder_count: 0,
    };
  }
  if (!Number.isFinite(Number(item.delivery.reminder_count))) item.delivery.reminder_count = 0;
  if (!item.objective_state) item.objective_state = 'current';
  if (!item.created_at) item.created_at = item.ts || iso(nowMs);
  return item;
}

function sessionIsLive(binding, nowMs = Date.now(), ttlMs = DEFAULT_SESSION_TTL_MS) {
  if (!binding || binding.closedAt || binding.closed_at || binding.status === 'closed') return false;
  const seen = timeMs(binding.lastSeen);
  return seen != null && seen + ttlMs > nowMs;
}

function liveSessionIds(sessions, workspace, nowMs, ttlMs) {
  return Object.entries(sessions || {})
    .filter(([, binding]) => (!workspace || binding.workspace === workspace) && sessionIsLive(binding, nowMs, ttlMs))
    .sort((a, b) => {
      const delta = (timeMs(b[1].lastSeen) || 0) - (timeMs(a[1].lastSeen) || 0);
      return delta || a[0].localeCompare(b[0]);
    })
    .map(([id]) => id);
}

function relevantSessions(item, overlay, sessions, graph, workspace, nowMs, ttlMs) {
  const live = new Set(liveSessionIds(sessions, workspace, nowMs, ttlMs));
  const preferred = [];
  const add = (id) => { if (id && live.has(String(id)) && !preferred.includes(String(id))) preferred.push(String(id)); };
  add(item.request_session);
  if (item.origin_task) {
    add(overlay.claimSessions && overlay.claimSessions[item.origin_task]);
    const task = graph && Array.isArray(graph.tasks) && graph.tasks.find((t) => t.id === item.origin_task);
    add(task && task.session);
  }
  for (const id of live) add(id);
  return preferred;
}

function releaseLease(item) {
  normalizeGuidance(item);
  item.delivery.session_id = null;
  item.delivery.leased_at = null;
  item.delivery.lease_expires_at = null;
}

function leaseTo(item, sessionId, nowMs, leaseMs) {
  normalizeGuidance(item, nowMs);
  item.delivery.session_id = sessionId;
  item.delivery.leased_at = iso(nowMs);
  item.delivery.lease_expires_at = iso(nowMs + leaseMs);
}

function noteSuperseded(overlay, key) {
  const note = (overlay.note_nodes || {})[String(key).replace(/^note:/, '')];
  return !!(note && (note.supersededBy || note.validTo));
}

// Only explicit structural facts make an objective stale. Missing tasks, changed wording, and other
// semantic uncertainty remain pending for a person; the daemon never guesses relevance.
function staleReason(overlay, item, graph) {
  const taskKey = item.origin_task;
  const notes = Array.isArray(item.origin_notes) ? item.origin_notes : [];
  if (taskKey) {
    const task = graph && Array.isArray(graph.tasks) && graph.tasks.find((t) => t.id === taskKey);
    const status = (overlay.status && overlay.status[taskKey]) || (task && task.status);
    const git = overlay.git && overlay.git[taskKey];
    if (status === 'done' || status === 'tested' || status === 'canceled' || (git && git.merged)) {
      return 'auto-stale: origin task objective is terminal';
    }
  }
  if (notes.some((key) => noteSuperseded(overlay, key))) return 'auto-stale: triggering note superseded';
  return null;
}

function resolveFirst(overlay, id, answer, nowMs = Date.now(), reason) {
  const item = (overlay.guidance || []).find((g) => g.id === id);
  if (!item) return { found: false, first: false, item: null };
  normalizeGuidance(item, nowMs);
  if (item.resolved) return { found: true, first: false, item };
  item.resolved = true;
  item.decision_state = reason === 'stale' ? 'stale' : 'resolved';
  item.resolvedAt = iso(nowMs);
  if (answer != null) item.answer = String(answer).slice(0, 2000);
  releaseLease(item);
  syncTaskHolds(overlay, nowMs);
  return { found: true, first: true, item };
}

function reconcileStale(overlay, nowMs = Date.now(), graph) {
  const resolved = [];
  for (const item of overlay.guidance || []) {
    normalizeGuidance(item, nowMs);
    if (!isActionable(item)) continue;
    const reason = staleReason(overlay, item, graph);
    if (!reason) {
      item.objective_state = item.origin_task || (item.origin_notes || []).length ? 'current' : 'ambiguous';
      continue;
    }
    item.objective_state = 'stale';
    const result = resolveFirst(overlay, item.id, reason, nowMs, 'stale');
    if (result.first) resolved.push(item.id);
  }
  syncTaskHolds(overlay, nowMs);
  return resolved;
}

function syncTaskHolds(overlay, nowMs = Date.now()) {
  if (!overlay.decision_holds || typeof overlay.decision_holds !== 'object') overlay.decision_holds = {};
  const wanted = new Map();
  for (const item of overlay.guidance || []) {
    normalizeGuidance(item, nowMs);
    if (isActionable(item) && item.origin_task) wanted.set(item.origin_task, item.id);
  }
  for (const key of Object.keys(overlay.decision_holds)) if (!wanted.has(key)) delete overlay.decision_holds[key];
  for (const [taskKey, guidanceId] of wanted) {
    if (!overlay.decision_holds[taskKey]) {
      overlay.decision_holds[taskKey] = { guidance_id: guidanceId, at: iso(nowMs) };
    }
  }
  return overlay.decision_holds;
}

function hasTaskHold(overlay, taskKey) {
  return !!(overlay.decision_holds && overlay.decision_holds[taskKey]);
}

function assignLeases(overlay, sessions, graph, workspace, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const ttlMs = opts.sessionTtlMs ?? DEFAULT_SESSION_TTL_MS;
  reconcileStale(overlay, nowMs, graph);
  let changed = false;
  const items = (overlay.guidance || []).filter(isActionable)
    .sort((a, b) => String(a.ts || '').localeCompare(String(b.ts || '')) || String(a.id).localeCompare(String(b.id)));
  for (const item of items) {
    normalizeGuidance(item, nowMs);
    const current = item.delivery.session_id;
    const expiry = timeMs(item.delivery.lease_expires_at);
    const binding = current && sessions && sessions[current];
    if (current && expiry != null && expiry > nowMs && sessionIsLive(binding, nowMs, ttlMs)) continue;
    if (current) { releaseLease(item); changed = true; }
    const next = relevantSessions(item, overlay, sessions, graph, workspace, nowMs, ttlMs)[0];
    if (next) { leaseTo(item, next, nowMs, leaseMs); changed = true; }
  }
  return changed;
}

function takeDueNudges(overlay, sessionId, sessions, graph, workspace, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now();
  const leaseMs = opts.leaseMs ?? DEFAULT_LEASE_MS;
  const baseMs = opts.reminderBaseMs ?? DEFAULT_REMINDER_BASE_MS;
  const maxMs = opts.reminderMaxMs ?? DEFAULT_REMINDER_MAX_MS;
  assignLeases(overlay, sessions, graph, workspace, { ...opts, nowMs, leaseMs });
  const nudges = [];
  for (const item of overlay.guidance || []) {
    if (!isActionable(item) || item.delivery.session_id !== sessionId) continue;
    const nextAt = timeMs(item.delivery.next_prompt_at);
    if (nextAt != null && nextAt > nowMs) continue;
    nudges.push({
      id: item.id,
      question: item.question,
      context: item.context,
      trigger: item.trigger,
      origin_task: item.origin_task || null,
      lease_expires_at: iso(nowMs + leaseMs),
    });
    item.delivery.reminder_count += 1;
    item.delivery.last_prompt_at = iso(nowMs);
    const delay = Math.min(maxMs, baseMs * (2 ** Math.max(0, item.delivery.reminder_count - 1)));
    item.delivery.next_prompt_at = iso(nowMs + delay);
    leaseTo(item, sessionId, nowMs, leaseMs);
  }
  return nudges;
}

module.exports = {
  DEFAULT_LEASE_MS,
  DEFAULT_REMINDER_BASE_MS,
  DEFAULT_REMINDER_MAX_MS,
  DEFAULT_SESSION_TTL_MS,
  assignLeases,
  hasTaskHold,
  isActionable,
  normalizeGuidance,
  reconcileStale,
  resolveFirst,
  sessionIsLive,
  staleReason,
  syncTaskHolds,
  takeDueNudges,
};
