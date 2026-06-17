'use strict';

const { listDispatcherChildren } = require('./dispatcher-children');

function focusForSession(ov, parentSid) {
  const df = ov && ov.dispatcher_focus;
  if (!df || typeof df !== 'object') return null;
  return df[parentSid] || null;
}

function childrenWithTaskKey(parentSid, ctx) {
  return listDispatcherChildren(parentSid, ctx).filter((c) => c.task_key);
}

// P3: there is no daemon-global workspace, so dispatcher_focus lives in the REQUEST's workspace
// overlay. Callers pass `sel = { b, u }` (the route's body + parsed URL) so targetOverlay resolves
// the SAME workspace the focus was written to. An empty selector degrades to the EMPTY overlay
// (no focus) rather than silently reading a global one.
function resolveOverlay(ctx, sel) {
  const b = (sel && sel.b) || null;
  const u = (sel && sel.u) || { searchParams: new URLSearchParams() };
  return ctx.targetOverlay(b, u);
}

function attributionMeta(parentSid, ctx, sel) {
  const children = listDispatcherChildren(parentSid, ctx);
  const withKeys = children.filter((c) => c.task_key);
  const T = resolveOverlay(ctx, sel);
  const focus = focusForSession(T.ov, parentSid);
  let attribution = null;
  let needs_focus = false;
  if (withKeys.length === 1) attribution = withKeys[0].task_key;
  else if (withKeys.length > 1) {
    needs_focus = true;
    if (focus && withKeys.some((c) => c.task_key === focus)) attribution = focus;
  }
  return { focus, attribution, needs_focus };
}

function resolveDispatcherAttribution(parentSid, ctx, explicitTaskKey = null, sel = null) {
  if (!parentSid) return { ok: false, error: 'parent_session required' };
  const children = childrenWithTaskKey(parentSid, ctx);
  if (!children.length) return { ok: false, error: 'no in-flight workers with task_key' };

  const T = resolveOverlay(ctx, sel);
  const focus = focusForSession(T.ov, parentSid);

  if (explicitTaskKey) {
    const hit = children.find((c) => c.task_key === explicitTaskKey);
    if (!hit) {
      return {
        ok: false,
        error: 'task_key not among running children',
        children: children.map((c) => c.task_key),
      };
    }
    return { ok: true, task_key: explicitTaskKey, agent_id: hit.agent_id, worker_session: hit.worker_session };
  }

  if (children.length === 1) {
    const c = children[0];
    return { ok: true, task_key: c.task_key, agent_id: c.agent_id, worker_session: c.worker_session, auto: true };
  }

  if (focus) {
    const hit = children.find((c) => c.task_key === focus);
    if (hit) {
      return { ok: true, task_key: focus, agent_id: hit.agent_id, worker_session: hit.worker_session, focus: true };
    }
  }

  return {
    ok: false,
    error: 'ambiguous attribution',
    needs_focus: true,
    children: children.map((c) => ({ task_key: c.task_key, label: c.label, agent_id: c.agent_id })),
    focus: focus || null,
  };
}

module.exports = {
  focusForSession,
  attributionMeta,
  resolveDispatcherAttribution,
};
