'use strict';

const path = require('path');
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

function wantsSameNodeReview(body) {
  return body && (body.create_judge === true || body.judge === true || body.judge_requested === true || !!cleanString(body.judge_task_key));
}

function normalizePermitPath(value, base) {
  const raw = String(value || '').replace(/\\/g, '/').trim();
  if (!raw) return '';
  const absolute = raw.startsWith('/') || /^[A-Za-z]:\//.test(raw);
  const resolved = absolute ? raw : `${String(base || '').replace(/\\/g, '/').replace(/\/+$/, '')}/${raw}`;
  return path.posix.normalize(resolved).replace(/\/+$/, '');
}

function activeClaimForPermit(ov, input) {
  if (!ov || !input) return null;
  const sessionId = cleanString(input.session_id);
  const taskKey = cleanString(input.task_key);
  if (!sessionId || !taskKey) return null;
  if (!ov.status || ov.status[taskKey] !== 'in_progress') return null;
  const claimSession = ov.claimSessions && ov.claimSessions[taskKey];
  if (claimSession && claimSession !== sessionId) return null;
  const assignee = cleanString(ov.assignee && ov.assignee[taskKey]);
  const agentId = cleanString(input.agent_id);
  if (agentId && assignee && agentId !== assignee) return null;
  const gitInfo = ov.git && ov.git[taskKey];
  const branch = cleanString(gitInfo && gitInfo.branch);
  const worktree = cleanString(gitInfo && gitInfo.worktree);
  const requestedBranch = cleanString(input.branch);
  if (requestedBranch && branch && requestedBranch !== branch) return null;
  const requestedWorktree = cleanString(input.worktree);
  if (requestedWorktree && worktree && normalizePermitPath(requestedWorktree, worktree) !== normalizePermitPath(worktree)) return null;
  return {
    workspace: cleanString(input.workspace),
    session_id: sessionId,
    task_key: taskKey,
    agent_id: assignee || agentId || null,
    branch: branch || null,
    worktree: worktree || null,
  };
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

function truncateText(value, max = 360) {
  const text = cleanString(value);
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3)).trimEnd()}...`;
}

function taskForKey(graph, key) {
  return graph && Array.isArray(graph.tasks) ? graph.tasks.find((x) => x.id === key) : null;
}

function compactDependencySummary(summary, index) {
  return {
    key: summary.key,
    label: truncateText(summary.label, 120),
    status: summary.status,
    summary: truncateText(summary.summary, 360),
    via: summary.via,
    priority: index + 1,
    weight: summary.relevance_score == null ? undefined : summary.relevance_score,
    reason: summary.reason ? truncateText(summary.reason, 220) : null,
  };
}

function buildProgressiveDisclosureContext(graph, ov, taskKey, dependencySummaries) {
  const task = taskForKey(graph, taskKey);
  const snapshot = ov.snapshots && ov.snapshots[taskKey];
  const status = (task && task.status) || ov.status[taskKey] || (snapshot && snapshot.status) || 'pending';
  const title = (task && task.label) || (snapshot && snapshot.subject) || taskKey;
  const description = (snapshot && snapshot.description) || (task && task.summary) || ov.summaries[taskKey] || '';
  const blocking = dependencySummaries
    .filter((summary) => summary.via === 'blocking')
    .map(compactDependencySummary);
  const requiredContext = dependencySummaries.map(compactDependencySummary);
  const files = new Set();
  const attempts = [];
  const gitInfo = (ov.git && ov.git[taskKey]) || null;
  if (gitInfo && gitInfo.worktree) attempts.push({ task_key: taskKey, branch: gitInfo.branch || null, worktree: gitInfo.worktree });
  const metadataFiles = snapshot && snapshot.metadata && Array.isArray(snapshot.metadata.files_in_scope)
    ? snapshot.metadata.files_in_scope
    : [];
  for (const file of metadataFiles) {
    const cleaned = cleanString(file);
    if (cleaned) files.add(cleaned);
  }
  return {
    version: 1,
    kind: 'subconscious_progressive_disclosure_context',
    layer1: {
      task: {
        key: taskKey,
        label: truncateText(title, 140),
        status,
        summary: truncateText(description || title, 360),
      },
      why: truncateText(description || `Complete ${title}.`, 360),
      next_action: 'Claim the assignment with subconscious_assignment.accept, work in the assigned worktree, commit changes, then complete with task_result.',
      must_know_constraints: [
        'Preserve existing assignment fields and consumers.',
        'Keep default context concise; use drill-down handles for deeper payloads.',
      ],
      blockers: blocking,
    },
    layer2: {
      dependency_summaries: requiredContext,
      required_files: Array.from(files),
    },
    layer3: {
      related_notes: requiredContext
        .filter((summary) => String(summary.key || '').startsWith('note:'))
        .map((summary) => ({ kind: 'note', key: summary.key, label: summary.label, summary: summary.summary, tool: 'search_knowledge' })),
      related_tasks: requiredContext
        .filter((summary) => !String(summary.key || '').startsWith('note:'))
        .map((summary) => ({ kind: 'task', key: summary.key, label: summary.label, summary: summary.summary, tool: 'get_task_detail' })),
      related_files: Array.from(files).map((path) => ({ kind: 'file', key: path, label: path, href: path })),
      prior_attempts: attempts.map((attempt) => ({
        kind: 'attempt',
        key: attempt.task_key,
        label: attempt.branch || attempt.task_key,
        href: attempt.worktree,
      })),
      full_trace: {
        kind: 'trace',
        key: taskKey,
        label: 'Full task trace',
        href: `/task/detail?key=${encodeURIComponent(taskKey)}&include_internal=1`,
      },
    },
    truncation: {
      layer1_max_chars: 360,
      summary_max_chars: 360,
      layer2_max_items: requiredContext.length,
      layer3_max_handles_per_kind: Math.max(requiredContext.length, files.size, attempts.length),
      truncated: false,
      omitted_counts: {},
    },
  };
}

function contextQueryForAssignment(body) {
  return cleanString(body.context_query || body.query || body.situation);
}

function wantsAgenticContext(body) {
  return body && (body.agentic_context === true || body.search_context === true || !!contextQueryForAssignment(body));
}

function summaryFromAgenticContext(agenticSearchContext, key) {
  const deps = agenticSearchContext && Array.isArray(agenticSearchContext.context_deps)
    ? agenticSearchContext.context_deps
    : [];
  const hit = deps.find((dep) => dep && (dep.key === key || dep.task_key === key));
  if (!hit) return null;
  return {
    key,
    label: hit.title || hit.key || key,
    status: 'context',
    summary: hit.summary || '',
    via: 'subconscious_agentic_search',
    relevance_score: hit.relevance_score == null ? null : hit.relevance_score,
    reason: hit.reason || null,
  };
}

function buildAssignmentEnvelope(ctx, T, input) {
  const graph = typeof ctx.buildGraph === 'function' ? ctx.buildGraph(T.ws) : { tasks: [] };
  const taskKey = input.task_key;
  const gitInfo = (T.ov.git && T.ov.git[taskKey]) || {};
  const lifecycle = overlayStore.reviewLifecycleFor(T.ov, taskKey, T.ov.status && T.ov.status[taskKey]);
  const reviewRequested = input.review_requested === true || lifecycle.review_state === 'requested' || lifecycle.review_state === 'pending';
  const repoPath = input.repo_path || (T.ov.repos && T.ov.repos[taskKey]) || T.ws || null;
  const graphTask = taskForKey(graph, taskKey);
  const parentKeys = normalizeStringArray(input.parent_task_keys);
  const contextKeys = normalizeStringArray(input.context_task_keys);
  if (!parentKeys.length && graphTask) parentKeys.push(...normalizeStringArray(graphTask.deps));
  if (!contextKeys.length && graphTask) contextKeys.push(...normalizeStringArray(graphTask.context_deps));
  const dependencySummaries = [
    ...parentKeys.map((key) => summaryForKey(graph, T.ov, key, 'blocking')),
    ...contextKeys.map((key) => summaryFromAgenticContext(input.agentic_search_context, key) || summaryForKey(graph, T.ov, key, 'context')),
  ];
  const progressiveDisclosureContext = buildProgressiveDisclosureContext(graph, T.ov, taskKey, dependencySummaries);
  const envelope = {
    version: 1,
    task_key: taskKey,
    judge_task_key: null,
    review_task_key: taskKey,
    review_requested: reviewRequested,
    review_state: lifecycle.review_state || null,
    legacy_judge_task_key: input.legacy_judge_task_key || lifecycle.legacy_judge_task_key || null,
    branch: gitInfo.branch || null,
    worktree: gitInfo.worktree || null,
    repo_path: repoPath,
    base: input.base || null,
    context: {
      parent_task_keys: parentKeys,
      context_task_keys: contextKeys,
      dependency_summaries: dependencySummaries,
      progressive_disclosure_context: progressiveDisclosureContext,
    },
    progressive_disclosure_context: progressiveDisclosureContext,
    next_expected_worker_action: 'subconscious_assignment.accept',
  };
  if (input.agentic_search_context) {
    envelope.context.agentic_search_context = input.agentic_search_context;
    envelope.agentic_search_context = input.agentic_search_context;
  }
  return envelope;
}

module.exports = (ctx) => async (p, m, req, res, u) => {
  const { send, readBody, targetOverlay } = ctx;
  const store = ctx.subconscious || defaultSubconsciousStore;

  if (p === '/subconscious/assignment' && m === 'GET') {
    const T = targetOverlay(null, u);
    if (!T.ws) { send(res, 400, { ok: false, error: 'workspace required' }); return true; }
    const taskKey = cleanString(u && u.searchParams.get('task_key'));
    if (!taskKey) { send(res, 400, { ok: false, error: 'task_key required' }); return true; }
    const input = {
      task_key: taskKey,
      legacy_judge_task_key: cleanString(u.searchParams.get('judge_task_key')),
      review_requested: !!cleanString(u.searchParams.get('judge_task_key')),
      repo_path: cleanString(u.searchParams.get('repo_path')),
      base: cleanString(u.searchParams.get('base')),
    };
    if (wantsAgenticContext({
      agentic_context: u.searchParams.get('agentic_context') === '1' || u.searchParams.get('agentic_context') === 'true',
      search_context: u.searchParams.get('search_context') === '1' || u.searchParams.get('search_context') === 'true',
      context_query: u.searchParams.get('context_query'),
      query: u.searchParams.get('query'),
      situation: u.searchParams.get('situation'),
    })) {
      const searchResult = await store.searchContext(ctx, {
        workspace: T.ws,
        agent_id: cleanString(u.searchParams.get('agent_id')) || 'subconscious-assignment',
        task_key: taskKey,
        intent: cleanString(u.searchParams.get('intent')) || taskKey,
        situation: cleanString(u.searchParams.get('context_query') || u.searchParams.get('situation') || u.searchParams.get('query')) || taskKey,
        query: cleanString(u.searchParams.get('context_query') || u.searchParams.get('query')),
        k: u.searchParams.get('k') || undefined,
        max_rounds: u.searchParams.get('max_rounds') || undefined,
      }, req);
      if (!searchResult.ok) {
        send(res, searchResult.status || 400, { ok: false, error: searchResult.error || 'subconscious context search failed' });
        return true;
      }
      input.agentic_search_context = searchResult.subconscious_context || null;
      input.context_task_keys = searchResult.context_task_keys || [];
    }
    const assignment = buildAssignmentEnvelope(ctx, T, {
      ...input,
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
    let agenticSearchContext = null;
    const agenticContextScores = new Map();
    if (wantsAgenticContext(b)) {
      const searchResult = await store.searchContext(ctx, {
        ...b,
        workspace: T.ws || b.workspace,
        agent_id: cleanString(b.agent_id) || 'subconscious-assignment',
        task_key: taskKey,
        intent: cleanString(b.intent) || cleanString(b.subject || b.title || b.description || b.prompt) || taskKey,
        situation: contextQueryForAssignment(b) || cleanString(b.description || b.prompt || b.subject || b.title),
        query: contextQueryForAssignment(b),
      }, req);
      if (!searchResult.ok) {
        send(res, searchResult.status || 400, { ok: false, error: searchResult.error || 'subconscious context search failed' });
        return true;
      }
      agenticSearchContext = searchResult.subconscious_context || null;
      for (const dep of (agenticSearchContext && agenticSearchContext.context_deps) || []) {
        const key = cleanString(dep && (dep.key || dep.task_key));
        if (!key || key === taskKey || contextKeys.includes(key)) continue;
        contextKeys.push(key);
        if (dep.relevance_score != null) agenticContextScores.set(key, dep.relevance_score);
      }
    }
    const reviewRequested = wantsSameNodeReview(b);
    const legacyJudgeTaskKey = reviewRequested ? (cleanString(b.judge_task_key) || defaultJudgeTaskKey(taskKey)) : null;
    const creatingKeys = new Set([taskKey]);
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
    for (const key of contextKeys) {
      const agentic = agenticContextScores.has(key);
      overlayStore.addEdge(T.ov, key, taskKey, null, 'context', agentic ? agenticContextScores.get(key) : undefined, agentic
        ? { origin: 'subconscious-agentic-search', by: 'subconscious', judged: true, score: agenticContextScores.get(key) }
        : { origin: 'subconscious-assignment' });
    }
    if (reviewRequested) {
      const reviewPatch = {
        review_state: 'requested',
        merge_state: 'review_pending',
        legacy_judge_task_key: legacyJudgeTaskKey,
      };
      const requestedBy = cleanString(b.agent_id);
      const requestedAt = typeof ctx.now === 'function' ? ctx.now() : new Date().toISOString();
      const reviewNote = cleanString(b.judge_description || b.judge_subject);
      if (requestedBy) reviewPatch.review_requested_by = requestedBy;
      if (requestedAt) reviewPatch.review_requested_at = requestedAt;
      if (reviewNote) {
        reviewPatch.review_note = reviewNote;
        reviewPatch.review_reason = reviewNote;
      }
      overlayStore.setReviewLifecycle(T.ov, taskKey, reviewPatch);
    }

    const repoPath = cleanString(b.repo_path);
    const repo = ctx.resolveRepo ? ctx.resolveRepo(taskKey, repoPath, T.ov, T.ws) : (repoPath || T.ws);
    if (!repo) { send(res, 400, { ok: false, error: 'repo_path or workspace required' }); return true; }
    overlayStore.setRepo(T.ov, taskKey, repo);
    if (b.test_cmd !== undefined) overlayStore.setTestCmd(T.ov, repo, b.test_cmd || '');

    let gitInfo = T.ov.git && T.ov.git[taskKey];
    if (!gitInfo || !gitInfo.worktree || b.reallocate === true) {
      if (!ctx.git || typeof ctx.git.createWorktreeAsync !== 'function') {
        send(res, 500, { ok: false, error: 'git worktree primitive unavailable' });
        return true;
      }
      if (typeof ctx.git.isRepoAsync === 'function' && !(await ctx.git.isRepoAsync(repo))) {
        if (typeof ctx.git.initRepoAsync === 'function') {
          const init = await ctx.git.initRepoAsync(repo);
          if (init && init.error) { send(res, 409, { ok: false, error: init.error, init }); return true; }
        } else {
          send(res, 409, { ok: false, error: 'target repo is not a git repo' });
          return true;
        }
      }
      const info = await ctx.git.createWorktreeAsync(repo, taskKey, { base: cleanString(b.base) || undefined });
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
      review_requested: reviewRequested,
      legacy_judge_task_key: legacyJudgeTaskKey,
      repo_path: repo,
      base: cleanString(b.base),
      parent_task_keys: parentKeys,
      context_task_keys: contextKeys,
      agentic_search_context: agenticSearchContext,
    });
    send(res, 200, {
      ok: true,
      action: 'prepare',
      workspace: T.ws,
      assignment,
      task_key: taskKey,
      judge_task_key: null,
      review_task_key: taskKey,
      review_requested: assignment.review_requested,
      review_state: assignment.review_state,
      legacy_judge_task_key: assignment.legacy_judge_task_key,
      branch: assignment.branch,
      worktree: assignment.worktree,
      repo_path: assignment.repo_path,
      next_expected_worker_action: assignment.next_expected_worker_action,
      git: gitInfo || null,
    });
    return true;
  }

  if (p === '/subconscious/search-context' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const result = await store.searchContext(ctx, { ...b, workspace: T.ws || b.workspace }, req);
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
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
    const input = {
      workspace: T.ws || (u && u.searchParams.get('workspace')),
      permit_id: u && (u.searchParams.get('permit_id') || u.searchParams.get('id')),
      session_id: u && u.searchParams.get('session_id'),
      agent_id: u && u.searchParams.get('agent_id'),
      foreground_agent_id: u && u.searchParams.get('foreground_agent_id'),
      task_key: u && u.searchParams.get('task_key'),
      now: u && u.searchParams.get('now'),
    };
    const result = store.readExecutionPermit({ ...input, active_claim: activeClaimForPermit(T.ov, input) });
    const code = result.status || (result.ok ? 200 : 400);
    const { status, ...body } = result;
    send(res, code, body);
    return true;
  }

  if (p === '/subconscious/permit' && m === 'POST') {
    const b = await readBody(req) || {};
    const T = targetOverlay(b, u);
    const input = { ...b, workspace: T.ws || b.workspace };
    const activeClaim = activeClaimForPermit(T.ov, input);
    if (cleanString(input.action || 'issue') === 'issue' && !activeClaim) {
      send(res, 409, { ok: false, error: 'execution permit issue requires a verified active claim for this session/task/worktree' });
      return true;
    }
    const result = store.executionPermit({ ...input, active_claim: activeClaim, require_active_claim: true });
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
