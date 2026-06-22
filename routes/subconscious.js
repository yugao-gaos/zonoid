'use strict';

const overlayStore = require('../lib/overlay');
const { defaultSubconsciousStore } = require('../lib/subconscious');

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeStringArray(value) {
  const items = Array.isArray(value)
    ? value
    : (typeof value === 'string' ? value.split(',') : []);
  const seen = new Set();
  const out = [];
  for (const item of items) {
    if (typeof item !== 'string') continue;
    const cleaned = item.trim();
    if (!cleaned || seen.has(cleaned)) continue;
    seen.add(cleaned);
    out.push(cleaned);
  }
  return out;
}

function slugify(value) {
  return cleanString(value).toLowerCase().replace(/[^a-z0-9_.-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 80);
}

function isAdmissibleTaskKey(key) {
  return typeof key === 'string'
    && (/^[^/\s]+\/[^/\s]+$/.test(key) || /^[A-Za-z][A-Za-z0-9_.-]*$/.test(key));
}

function resolveAssignmentTaskKey(body) {
  const explicit = cleanString(body.task_key || body.anchor_task_key || body.selected_task_key);
  if (explicit) return explicit;
  const rawId = cleanString(body.id || body.task_id || body.slug);
  if (rawId) return rawId.includes('/') ? rawId : `${cleanString(body.harness || body.namespace) || 'codex'}/${slugify(rawId)}`;
  const label = cleanString(body.subject || body.title || body.prompt || body.intent);
  return label ? `${cleanString(body.harness || body.namespace) || 'codex'}/${slugify(label)}` : '';
}

function defaultJudgeTaskKey(taskKey) {
  const i = taskKey.indexOf('/');
  if (i === -1) return `${taskKey}-judge`;
  return `${taskKey.slice(0, i + 1)}${taskKey.slice(i + 1)}-judge`;
}

function ensureTaskSnapshot(ctx, T, key, body, fallbackSubject) {
  if (!isAdmissibleTaskKey(key) || key.startsWith('note:')) return;
  if (T.ov.snapshots && T.ov.snapshots[key]) return;
  const subject = cleanString(body.subject || body.title || fallbackSubject) || key;
  overlayStore.setSnapshot(T.ov, key, {
    subject,
    description: cleanString(body.description || body.prompt),
    status: T.ov.status[key] || 'pending',
    blockedBy: [],
    owner: null,
    metadata: { synthetic_overlay_task: true, created_by: 'subconscious_assignment' },
  });
  if (!T.ov.timestamps) T.ov.timestamps = {};
  if (!T.ov.timestamps[key] && typeof ctx.now === 'function') {
    const ts = ctx.now();
    T.ov.timestamps[key] = { firstSeen: ts, lastChanged: ts, lastStatus: T.ov.status[key] || 'pending' };
  }
  if (ctx.cache) {
    if (ctx.cache.agg) ctx.cache.agg.delete(T.ws);
    if (ctx.cache.aggAt) ctx.cache.aggAt.delete(T.ws);
  }
}

function graphHasKey(ctx, T, key) {
  if (typeof ctx.buildGraph !== 'function') return false;
  const graph = ctx.buildGraph(T.ws);
  if (typeof ctx.nodeExistsInGraph === 'function') return ctx.nodeExistsInGraph(graph, key);
  return !!(graph && Array.isArray(graph.tasks) && graph.tasks.some((t) => t.id === key));
}

function assignmentDependencyExists(ctx, T, key, creatingKeys) {
  return creatingKeys.has(key)
    || graphHasKey(ctx, T, key)
    || !!(T.ov.snapshots && T.ov.snapshots[key])
    || !!(T.ov.knowledge_nodes && T.ov.knowledge_nodes[key]);
}

function summaryForKey(graph, ov, key, via) {
  const t = graph && Array.isArray(graph.tasks) ? graph.tasks.find((x) => x.id === key) : null;
  return {
    key,
    label: (t && t.label) || (ov.snapshots && ov.snapshots[key] && ov.snapshots[key].subject) || key,
    status: (t && t.status) || ov.status[key] || '?',
    summary: (t && t.summary) || ov.summaries[key] || '',
    via,
  };
}

function buildAssignmentEnvelope(ctx, T, input) {
  const graph = typeof ctx.buildGraph === 'function' ? ctx.buildGraph(T.ws) : { tasks: [] };
  const taskKey = input.task_key;
  const gitInfo = (T.ov.git && T.ov.git[taskKey]) || {};
  const repoPath = input.repo_path || (T.ov.repos && T.ov.repos[taskKey]) || T.ws || null;
  const parentKeys = normalizeStringArray(input.parent_task_keys);
  const contextKeys = normalizeStringArray(input.context_task_keys);
  const dependencySummaries = [
    ...parentKeys.map((key) => summaryForKey(graph, T.ov, key, 'blocking')),
    ...contextKeys.map((key) => summaryForKey(graph, T.ov, key, 'context')),
  ];
  return {
    version: 1,
    task_key: taskKey,
    judge_task_key: input.judge_task_key || null,
    branch: gitInfo.branch || null,
    worktree: gitInfo.worktree || null,
    repo_path: repoPath,
    base: input.base || null,
    context: {
      parent_task_keys: parentKeys,
      context_task_keys: contextKeys,
      dependency_summaries: dependencySummaries,
    },
    next_expected_worker_action: 'subconscious_assignment.accept',
  };
}

module.exports = (ctx) => async (p, m, req, res, u) => {
  const { send, readBody, targetOverlay } = ctx;
  const store = ctx.subconscious || defaultSubconsciousStore;

  if (p === '/subconscious/assignment' && m === 'GET') {
    const T = targetOverlay(null, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const taskKey = cleanString(u && u.searchParams.get('task_key'));
    if (!taskKey) { send(res, 400, { ok: false, error: 'task_key required' }); return true; }
    const assignment = buildAssignmentEnvelope(ctx, T, {
      task_key: taskKey,
      judge_task_key: cleanString(u.searchParams.get('judge_task_key')),
      repo_path: cleanString(u.searchParams.get('repo_path')),
      base: cleanString(u.searchParams.get('base')),
    });
    send(res, 200, { ok: true, action: 'read', workspace: T.ws, assignment });
    return true;
  }

  if (p === '/subconscious/assignment' && m === 'POST') {
    const b = await readBody(req) || {};
    const action = cleanString(b.action || 'prepare');
    if (action !== 'prepare') {
      send(res, 400, { ok: false, error: 'subconscious assignment route only handles action "prepare"' });
      return true;
    }
    const T = targetOverlay(b, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const taskKey = resolveAssignmentTaskKey(b);
    if (!taskKey || !isAdmissibleTaskKey(taskKey)) {
      send(res, 400, { ok: false, error: 'task_key or task id required' });
      return true;
    }

    const parentKeys = normalizeStringArray(b.parent_task_keys || b.blocked_by || b.blockedBy);
    const contextKeys = normalizeStringArray(b.context_task_keys || b.context_deps);
    const createJudge = b.create_judge === true || b.judge === true || b.judge_requested === true || !!cleanString(b.judge_task_key);
    const judgeTaskKey = createJudge ? (cleanString(b.judge_task_key) || defaultJudgeTaskKey(taskKey)) : null;
    const creatingKeys = new Set([taskKey]);
    if (judgeTaskKey) creatingKeys.add(judgeTaskKey);
    const unknownDependency = parentKeys.concat(contextKeys).find((key) => !assignmentDependencyExists(ctx, T, key, creatingKeys));
    if (unknownDependency) {
      send(res, 404, { ok: false, error: `unknown task: ${unknownDependency}` });
      return true;
    }

    ensureTaskSnapshot(ctx, T, taskKey, b, b.subject || b.title || taskKey);
    for (const key of parentKeys.concat(contextKeys)) {
      if (!creatingKeys.has(key)) ensureTaskSnapshot(ctx, T, key, {}, key);
    }
    for (const key of parentKeys) overlayStore.addEdge(T.ov, key, taskKey, null, 'blocking', null, { origin: 'subconscious-assignment' });
    for (const key of contextKeys) overlayStore.addEdge(T.ov, key, taskKey, null, 'context', undefined, { origin: 'subconscious-assignment' });
    if (judgeTaskKey) {
      ensureTaskSnapshot(ctx, T, judgeTaskKey, {
        subject: b.judge_subject || `Judge ${taskKey}`,
        description: b.judge_description || `Review attempt for ${taskKey}.`,
      }, `Judge ${taskKey}`);
      overlayStore.addEdge(T.ov, taskKey, judgeTaskKey, null, 'blocking', null, { origin: 'subconscious-assignment' });
    }

    const repoPath = cleanString(b.repo_path);
    const repo = ctx.resolveRepo ? ctx.resolveRepo(taskKey, repoPath, T.ov, T.ws) : (repoPath || T.ws);
    if (!repo) { send(res, 400, { ok: false, error: 'repo_path or workspace required' }); return true; }
    overlayStore.setRepo(T.ov, taskKey, repo);
    if (judgeTaskKey) overlayStore.setRepo(T.ov, judgeTaskKey, repo);
    if (b.test_cmd !== undefined) overlayStore.setTestCmd(T.ov, repo, b.test_cmd || '');

    let gitInfo = T.ov.git && T.ov.git[taskKey];
    if (!gitInfo || !gitInfo.worktree || b.reallocate === true) {
      if (!ctx.git || typeof ctx.git.createWorktree !== 'function') {
        send(res, 500, { ok: false, error: 'git worktree primitive unavailable' });
        return true;
      }
      if (typeof ctx.git.isRepo === 'function' && !ctx.git.isRepo(repo)) {
        if (typeof ctx.git.initRepo === 'function') {
          const init = ctx.git.initRepo(repo);
          if (init && init.error) { send(res, 409, { ok: false, error: init.error, init }); return true; }
        } else {
          send(res, 409, { ok: false, error: 'target repo is not a git repo' });
          return true;
        }
      }
      const info = ctx.git.createWorktree(repo, taskKey, { base: cleanString(b.base) || undefined });
      if (info && info.contended) {
        send(res, 409, { ...info, ok: false, repo, error: 'worktree path is currently leased by another creator; retry subconscious_assignment action:"prepare"' });
        return true;
      }
      overlayStore.setGit(T.ov, taskKey, info);
      gitInfo = T.ov.git && T.ov.git[taskKey];
    }

    T.save();
    if (typeof ctx.notifyChange === 'function') ctx.notifyChange(T.ws);
    const assignment = buildAssignmentEnvelope(ctx, T, {
      task_key: taskKey,
      judge_task_key: judgeTaskKey,
      repo_path: repo,
      base: cleanString(b.base),
      parent_task_keys: parentKeys,
      context_task_keys: contextKeys,
    });
    send(res, 200, {
      ok: true,
      action: 'prepare',
      workspace: T.ws,
      assignment,
      task_key: taskKey,
      judge_task_key: judgeTaskKey,
      branch: assignment.branch,
      worktree: assignment.worktree,
      repo_path: assignment.repo_path,
      next_expected_worker_action: assignment.next_expected_worker_action,
      git: gitInfo || null,
    });
    return true;
  }

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

  if (p === '/subconscious/session-companion' && m === 'GET') {
    const T = targetOverlay(null, u);
    const result = store.readSessionCompanion({
      workspace: T.ws || (u && u.searchParams.get('workspace')),
      session_id: u && u.searchParams.get('session_id'),
      limit: u && u.searchParams.get('limit'),
    });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/session-companion' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.upsertSessionCompanion({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/session-companion/observation' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.recordSessionCompanionObservation({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/anchor' && m === 'GET') {
    const T = targetOverlay(null, u);
    const result = store.readAnchorAllocation({
      workspace: T.ws || (u && u.searchParams.get('workspace')),
      session_id: u && u.searchParams.get('session_id'),
      companion_agent_id: u && u.searchParams.get('companion_agent_id'),
      companion_loop_id: u && u.searchParams.get('companion_loop_id'),
      limit: u && u.searchParams.get('limit'),
      decision_limit: u && u.searchParams.get('decision_limit'),
    });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/anchor' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.upsertAnchorAllocation({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/anchor/observation' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.recordAnchorObservation({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/anchor/decision' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.recordAnchorDecision({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/idea-scheduler' && m === 'GET') {
    const T = targetOverlay(null, u);
    const result = store.readIdeas({
      workspace: T.ws || (u && u.searchParams.get('workspace')),
      agent_id: u && u.searchParams.get('agent_id'),
      session_id: u && u.searchParams.get('session_id'),
      companion_agent_id: u && u.searchParams.get('companion_agent_id'),
      companion_loop_id: u && u.searchParams.get('companion_loop_id'),
      task_key: u && u.searchParams.get('task_key'),
      limit: u && u.searchParams.get('limit'),
    });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/idea-scheduler' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.scheduleIdea({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/permit' && m === 'GET') {
    const T = targetOverlay(null, u);
    const result = store.readExecutionPermit({
      workspace: T.ws || (u && u.searchParams.get('workspace')),
      permit_id: u && (u.searchParams.get('permit_id') || u.searchParams.get('id')),
      session_id: u && u.searchParams.get('session_id'),
      agent_id: u && u.searchParams.get('agent_id'),
      foreground_agent_id: u && u.searchParams.get('foreground_agent_id'),
      task_key: u && u.searchParams.get('task_key'),
      now: u && u.searchParams.get('now'),
    });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/permit' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.executionPermit({ ...b, workspace: T.ws || b.workspace });
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

  if (p === '/subconscious/skill' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = store.skill({ ...b, workspace: T.ws || b.workspace });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  return false;
};
