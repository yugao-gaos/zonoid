'use strict';

function subconsciousTools(deps) {
  const { q, UI_URI, PORT, runSubconsciousAssignment } = deps;
  return [
  {
    name: 'subconscious_search_context',
    description: 'Ask Subconscious for a judged agentic search context envelope for a task or assignment. It internally runs an adaptive, budgeted task-gated DAG and broad RAG/follow-up search loop, filters low-value hits, and returns only context selected as useful so agents need not call raw search_knowledge to decompose worker context.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent whose Subconscious state should answer the request.' },
        workspace: { type: 'string', description: 'Workspace path. Defaults to the session workspace when omitted by the transport.' },
        task_key: { type: 'string', description: 'Optional current task or assignment key; enables task-gated DAG context retrieval.' },
        intent: { type: 'string', description: 'What context decision or task decomposition support the agent wants.' },
        situation: { type: 'string', description: 'Current task context for the search.' },
        query: { type: 'string', description: 'Free-form task query when intent/situation are not split.' },
        k: { type: 'number', description: 'Maximum selected context items to return.' },
        max_rounds: { type: 'number', description: 'Maximum internal adaptive search rounds.' },
        include_internal: { type: 'boolean', description: 'Return compact internal planner diagnostics under internal.' },
        debug: { type: 'boolean', description: 'Alias for include_internal.' },
      },
      required: ['agent_id'],
      additionalProperties: false,
    },
    run: (a, call) => {
      if (!a.intent && !a.situation && !a.query) {
        throw new Error('subconscious_search_context requires at least one of: intent, situation, query');
      }
      return call('POST', '/subconscious/search-context', {
        agent_id: a.agent_id,
        workspace: a.workspace,
        task_key: a.task_key,
        intent: a.intent,
        situation: a.situation,
        query: a.query,
        k: a.k,
        max_rounds: a.max_rounds,
        include_internal: a.include_internal,
        debug: a.debug,
      });
    },
  },
{
    name: 'ask_subconscious',
    description: 'Ask the per-agent Subconscious for the foreground agent-facing surface: a single Subconscious envelope with verdict, prediction, context, anchor, next-action pressure, approval posture, and execution permit requirement. It may use internal RAG/DAG search, recent per-agent state, and existing session/anchor state, but does not execute implementation or expose raw search as the primitive.',
    inputSchema: {
      type: 'object',
      properties: {
        agent_id: { type: 'string', description: 'Agent whose Subconscious state should answer the request.' },
        workspace: { type: 'string', description: 'Workspace path. Defaults to the session workspace when omitted by the transport.' },
        task_key: { type: 'string', description: 'Optional current task or claim key; enables task-gated internal context retrieval.' },
        session_id: { type: 'string', description: 'Optional foreground session identity used to read existing companion and anchor state.' },
        foreground_agent_id: { type: 'string', description: 'Optional foreground executor identity active in the session.' },
        companion_agent_id: { type: 'string', description: 'Optional Subconscious companion identity used to read existing anchor state.' },
        companion_loop_id: { type: 'string', description: 'Optional Subconscious companion loop identity used to read existing anchor state.' },
        intent: { type: 'string', description: 'What decision or next-step support the agent wants.' },
        situation: { type: 'string', description: 'Current context for the request.' },
        query: { type: 'string', description: 'Free-form prompt when intent/situation are not split.' },
        approval_signals: { type: 'array', items: { type: 'string' }, description: 'Optional policy signals, e.g. high_impact or deployment, used only to shape approval posture.' },
        approval_required: { type: 'boolean', description: 'Explicitly mark the requested action as needing user approval.' },
        high_impact: { type: 'boolean' },
        outward_facing: { type: 'boolean' },
        irreversible: { type: 'boolean' },
        scope_expanding: { type: 'boolean' },
        destructive: { type: 'boolean' },
        deployment: { type: 'boolean' },
        api_change: { type: 'boolean' },
        repeated_failure: { type: 'boolean' },
        k: { type: 'number', description: 'Maximum internal evidence items to consider.' },
        include_internal: { type: 'boolean', description: 'Return internal planner/search/event diagnostics under internal.' },
        debug: { type: 'boolean', description: 'Alias for include_internal.' },
      },
      required: ['agent_id'],
      additionalProperties: false,
    },
    run: (a, call) => {
      if (!a.intent && !a.situation && !a.query) {
        throw new Error('ask_subconscious requires at least one of: intent, situation, query');
      }
      return call('POST', '/subconscious/ask', {
        agent_id: a.agent_id,
        workspace: a.workspace,
        task_key: a.task_key,
        session_id: a.session_id,
        foreground_agent_id: a.foreground_agent_id,
        companion_agent_id: a.companion_agent_id,
        companion_loop_id: a.companion_loop_id,
        intent: a.intent,
        situation: a.situation,
        query: a.query,
        approval_signals: a.approval_signals,
        approval_required: a.approval_required,
        high_impact: a.high_impact,
        outward_facing: a.outward_facing,
        irreversible: a.irreversible,
        scope_expanding: a.scope_expanding,
        destructive: a.destructive,
        deployment: a.deployment,
        api_change: a.api_change,
        repeated_failure: a.repeated_failure,
        k: a.k,
        include_internal: a.include_internal,
        debug: a.debug,
      });
    },
  },
{ name: 'subconscious_execution_permit', description: 'Issue, read, or revoke a scoped Subconscious execution permit for foreground writes. Issuing requires a verified active claim for the same session_id, task_key, worktree, and branch. A permit is external write authority bound to session/task/worktree identity, optional agent identities, expiration, and allowed path scope; the write gate still validates it against the active task claim/worktree.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['issue', 'read', 'revoke'], description: 'issue = create a scoped permit for a verified active claim; read = fetch the latest matching permit; revoke = revoke the latest matching permit or permit_id.' }, workspace: { type: 'string', description: 'Workspace path. Defaults to the session workspace when omitted by the transport.' }, permit_id: { type: 'string' }, session_id: { type: 'string' }, agent_id: { type: 'string' }, foreground_agent_id: { type: 'string' }, task_key: { type: 'string' }, worktree: { type: 'string' }, branch: { type: 'string' }, scope: { type: 'string', enum: ['worktree', 'repo', 'paths'] }, allowed_paths: { type: 'array', items: { type: 'string' } }, expires_at: { type: 'string' }, ttl_seconds: { type: 'number' }, ttl_ms: { type: 'number' }, reason: { type: 'string' }, payload: {}, now: { type: 'string' } }, required: ['action'], additionalProperties: false }, run: (a, call) => {
      if (a.action === 'read') return call('GET', `/subconscious/permit?${q({ workspace: a.workspace, permit_id: a.permit_id, session_id: a.session_id, agent_id: a.agent_id, foreground_agent_id: a.foreground_agent_id, task_key: a.task_key, now: a.now })}`);
      return call('POST', '/subconscious/permit', {
        action: a.action,
        workspace: a.workspace,
        permit_id: a.permit_id,
        session_id: a.session_id,
        agent_id: a.agent_id,
        foreground_agent_id: a.foreground_agent_id,
        task_key: a.task_key,
        worktree: a.worktree,
        branch: a.branch,
        scope: a.scope,
        allowed_paths: a.allowed_paths,
        expires_at: a.expires_at,
        ttl_seconds: a.ttl_seconds,
        ttl_ms: a.ttl_ms,
        reason: a.reason,
        payload: a.payload,
        now: a.now,
      });
    } },
{
    name: 'subconscious_skill',
    description: 'Manage deterministic Subconscious skill candidate lifecycle plumbing. Actions propose generated skill markdown into the version/proposal stores, record supplied active-vs-candidate measurements, promote only measured clean winners, roll back promotions, list capped proposals, and record/list third-party keep/archive/replace recommendations. This never overwrites SKILL.md; activation is manifest/version based.',
    inputSchema: {
      type: 'object',
      properties: {
        action: { type: 'string', enum: ['propose_candidate', 'record_evaluation', 'promote_winner', 'rollback_promotion', 'list_proposals', 'recommend_third_party', 'list_third_party_recommendations'] },
        workspace: { type: 'string', description: 'Workspace path. Defaults to the session workspace when omitted by the transport.' },
        agent_id: { type: 'string' },
        task_key: { type: 'string' },
        now: { type: 'string' },
        source: { type: 'string' },
        run_id: { type: 'string' },
        notes: { type: 'string' },
        skill_id: { type: 'string' },
        name: { type: 'string' },
        title: { type: 'string' },
        skill_path: { type: 'string' },
        target_path: { type: 'string' },
        path: { type: 'string' },
        skill_markdown: { type: 'string' },
        markdown: { type: 'string' },
        content: { type: 'string' },
        candidate_version_id: { type: 'string' },
        version_id: { type: 'string' },
        active_version_id: { type: 'string' },
        baseline_version_id: { type: 'string' },
        evaluation_id: { type: 'string' },
        promotion_id: { type: 'string' },
        decision_id: { type: 'string' },
        active: { type: 'object' },
        candidate: { type: 'object' },
        evaluation: { type: 'object' },
        metric_spec: { type: 'object' },
        metric: { type: 'object' },
        spec: { type: 'object' },
        measurements: { type: 'object' },
        active_measurement: {},
        candidate_measurement: {},
        evaluation_type: { type: 'string' },
        case_ids: { type: 'array', items: { type: 'string' } },
        capability: { type: 'string' },
        area: { type: 'string' },
        signature: { type: 'string' },
        capability_signature: { type: 'string' },
        overlap_signature: { type: 'string' },
        overlap_keys: { type: 'array', items: { type: 'string' } },
        evidence: { type: 'array', items: {} },
        evidence_count: { type: 'number' },
        promotion_outcome: { type: 'string' },
        evaluation_outcome: { type: 'string' },
        expires_at: { type: 'string' },
        policy: { type: 'object' },
        provenance: { type: 'object' },
        limit: { type: 'number' },
        status: { type: 'string' },
        recommendation: { type: 'string' },
        usage_count: { type: 'number' },
        overlap_score: { type: 'number' },
        security_risk: { type: 'boolean' },
        security: { type: 'string' },
        stale: { type: 'boolean' },
        freshness: { type: 'string' },
        automatic_cleanup: { type: 'boolean' },
        force: { type: 'boolean' },
        expire_stale: { type: 'boolean' },
      },
      required: ['action'],
      additionalProperties: false,
    },
    run: (a, call) => call('POST', '/subconscious/skill', a),
  },
{ name: 'subconscious_loop', description: 'Create, update, observe, or read daemon-owned Subconscious loop state. This records bounded process-local ticks/observations for a workspace + loop + agent identity; it does not allocate task anchors, schedule ideas, or execute work.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['update', 'observe', 'read'], description: 'update = upsert loop state; observe = append a tick/observation; read = fetch current loop state.' }, agent_id: { type: 'string', description: 'Daemon or companion agent identity for the loop.' }, workspace: { type: 'string', description: 'Workspace path. Defaults to the session workspace when omitted by the transport.' }, loop_id: { type: 'string', description: 'Stable loop identity, such as central or a session companion loop id.' }, status: { type: 'string' }, phase: { type: 'string' }, directive: { type: 'string' }, type: { type: 'string', description: 'Observation type for action:"observe", e.g. tick or observation.' }, text: { type: 'string' }, task_key: { type: 'string' }, payload: {}, confidence: { type: 'number' }, limit: { type: 'number' }, now: { type: 'string' } }, required: ['action', 'agent_id', 'loop_id'], additionalProperties: false }, run: (a, call) => {
      if (a.action === 'read') return call('GET', `/subconscious/loop?${q({ workspace: a.workspace, loop_id: a.loop_id, agent_id: a.agent_id, limit: a.limit })}`);
      if (a.action === 'observe') return call('POST', '/subconscious/loop/observation', { agent_id: a.agent_id, workspace: a.workspace, loop_id: a.loop_id, type: a.type, text: a.text, task_key: a.task_key, payload: a.payload, confidence: a.confidence, status: a.status, phase: a.phase, directive: a.directive, now: a.now });
      if (a.action === 'update') return call('POST', '/subconscious/loop', { agent_id: a.agent_id, workspace: a.workspace, loop_id: a.loop_id, status: a.status, phase: a.phase, directive: a.directive, payload: a.payload, now: a.now });
      return { error: 'action must be "update", "observe", or "read"' };
    } },
{ name: 'subconscious_session_companion', description: 'Create, update, observe, or read a process-local pairing between a foreground session and its Subconscious companion. This records bounded companion observations only; it does not allocate task anchors, schedule ideas, pressure agents, or execute work.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['update', 'observe', 'read'], description: 'update = upsert pairing metadata; observe = append a companion observation; read = fetch current pairing.' }, workspace: { type: 'string', description: 'Workspace path. Defaults to the session workspace when omitted by the transport.' }, session_id: { type: 'string', description: 'Foreground session identity paired with a Subconscious companion.' }, foreground_agent_id: { type: 'string', description: 'Optional foreground agent identity active in the session.' }, companion_agent_id: { type: 'string', description: 'Subconscious companion agent identity. Required when creating a new pairing.' }, companion_loop_id: { type: 'string', description: 'Subconscious companion loop identity. Defaults to a deterministic session companion loop id when omitted.' }, status: { type: 'string' }, type: { type: 'string', description: 'Observation type for action:"observe", e.g. tick, observation, or progress.' }, text: { type: 'string' }, task_key: { type: 'string' }, payload: {}, confidence: { type: 'number' }, limit: { type: 'number' }, now: { type: 'string' } }, required: ['action', 'session_id'], additionalProperties: false }, run: (a, call) => {
      if (a.action === 'read') return call('GET', `/subconscious/session-companion?${q({ workspace: a.workspace, session_id: a.session_id, limit: a.limit })}`);
      if (a.action === 'observe') return call('POST', '/subconscious/session-companion/observation', { workspace: a.workspace, session_id: a.session_id, foreground_agent_id: a.foreground_agent_id, companion_agent_id: a.companion_agent_id, companion_loop_id: a.companion_loop_id, status: a.status, type: a.type, text: a.text, task_key: a.task_key, payload: a.payload, confidence: a.confidence, now: a.now });
      if (a.action === 'update') return call('POST', '/subconscious/session-companion', { workspace: a.workspace, session_id: a.session_id, foreground_agent_id: a.foreground_agent_id, companion_agent_id: a.companion_agent_id, companion_loop_id: a.companion_loop_id, status: a.status, payload: a.payload, now: a.now });
      return { error: 'action must be "update", "observe", or "read"' };
    } },
{ name: 'subconscious_anchor_allocator', description: 'Record, observe, decide on, or read a process-local Subconscious task anchor allocation for a foreground session/companion identity. This stores DAG-oriented references and proposed wiring metadata only; it does not create graph tasks, mutate edges, schedule ideas, pressure agents, or execute work.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['update', 'observe', 'decide', 'read'], description: 'update = record the current anchored task reference; observe = append bounded context; decide = append bounded allocation decision; read = fetch current anchor state.' }, workspace: { type: 'string', description: 'Workspace path. Defaults to the session workspace when omitted by the transport.' }, session_id: { type: 'string', description: 'Foreground session identity that owns this anchor context.' }, foreground_agent_id: { type: 'string', description: 'Optional foreground agent identity active in the session.' }, companion_agent_id: { type: 'string', description: 'Optional Subconscious companion identity used to isolate the anchor context.' }, companion_loop_id: { type: 'string', description: 'Optional Subconscious companion loop identity used to isolate the anchor context.' }, task_key: { type: 'string', description: 'Explicit DAG task key selected or proposed as the current anchor.' }, reason: { type: 'string', description: 'Reason for the anchor update or decision.' }, status: { type: 'string' }, parent_task_keys: { type: 'array', items: { type: 'string' }, description: 'Optional blocking/parent task keys proposed as wiring metadata.' }, context_task_keys: { type: 'array', items: { type: 'string' }, description: 'Optional non-blocking context task keys proposed as wiring metadata.' }, type: { type: 'string', description: 'Observation type for action:"observe".' }, text: { type: 'string' }, decision: { type: 'string', description: 'Decision label for action:"decide", such as proposed, selected, or rejected.' }, payload: {}, confidence: { type: 'number' }, limit: { type: 'number' }, decision_limit: { type: 'number' }, now: { type: 'string' } }, required: ['action', 'session_id'], additionalProperties: false }, run: (a, call) => {
      if (a.action === 'read') return call('GET', `/subconscious/anchor?${q({ workspace: a.workspace, session_id: a.session_id, companion_agent_id: a.companion_agent_id, companion_loop_id: a.companion_loop_id, limit: a.limit, decision_limit: a.decision_limit })}`);
      if (a.action === 'observe') return call('POST', '/subconscious/anchor/observation', { workspace: a.workspace, session_id: a.session_id, foreground_agent_id: a.foreground_agent_id, companion_agent_id: a.companion_agent_id, companion_loop_id: a.companion_loop_id, task_key: a.task_key, status: a.status, type: a.type, text: a.text, payload: a.payload, confidence: a.confidence, now: a.now });
      if (a.action === 'decide') return call('POST', '/subconscious/anchor/decision', { workspace: a.workspace, session_id: a.session_id, foreground_agent_id: a.foreground_agent_id, companion_agent_id: a.companion_agent_id, companion_loop_id: a.companion_loop_id, task_key: a.task_key, status: a.status, decision: a.decision, reason: a.reason, payload: a.payload, confidence: a.confidence, now: a.now });
      if (a.action === 'update') return call('POST', '/subconscious/anchor', { workspace: a.workspace, session_id: a.session_id, foreground_agent_id: a.foreground_agent_id, companion_agent_id: a.companion_agent_id, companion_loop_id: a.companion_loop_id, task_key: a.task_key, reason: a.reason, status: a.status, parent_task_keys: a.parent_task_keys, context_task_keys: a.context_task_keys, payload: a.payload, now: a.now });
      return { error: 'action must be "update", "observe", "decide", or "read"' };
    } },
{ name: 'subconscious_idea_scheduler', description: 'Classify and record daemon/background Subconscious ideas as process-local proposals. Ordinary ideas are recorded as schedulable; high-impact, outward-facing, irreversible, scope-expanding, destructive, deployment, API-change, or repeated-failure ideas are returned as requiring approval. This does not create tasks, execute work, deploy, or merge.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['schedule', 'read'], description: 'schedule = classify and record an idea proposal; read = fetch recent proposals for the identity.' }, workspace: { type: 'string', description: 'Workspace path. Defaults to the session workspace when omitted by the transport.' }, agent_id: { type: 'string', description: 'Daemon or companion agent identity that produced the idea.' }, session_id: { type: 'string', description: 'Optional foreground session identity anchoring this idea.' }, foreground_agent_id: { type: 'string', description: 'Optional foreground agent identity active in the session.' }, companion_agent_id: { type: 'string', description: 'Optional Subconscious companion identity used to isolate ideas.' }, companion_loop_id: { type: 'string', description: 'Optional Subconscious loop identity used to isolate ideas.' }, task_key: { type: 'string', description: 'Optional DAG task key the idea is anchored to.' }, source: { type: 'string', description: 'Optional source label, such as daemon_loop or session_companion.' }, title: { type: 'string' }, idea: { type: 'string', description: 'Idea text to classify for action:"schedule".' }, reason: { type: 'string', description: 'Why the idea was produced.' }, parent_task_keys: { type: 'array', items: { type: 'string' }, description: 'Optional blocking/parent task keys proposed as wiring metadata only.' }, context_task_keys: { type: 'array', items: { type: 'string' }, description: 'Optional non-blocking context task keys proposed as wiring metadata only.' }, approval_signals: { type: 'array', items: { type: 'string' }, description: 'Optional explicit policy signals, e.g. high_impact or deployment.' }, approval_required: { type: 'boolean', description: 'Explicitly force the proposal into requires_approval.' }, payload: {}, confidence: { type: 'number' }, limit: { type: 'number' }, now: { type: 'string' } }, required: ['action', 'agent_id'], additionalProperties: false }, run: (a, call) => {
      if (a.action === 'read') return call('GET', `/subconscious/idea-scheduler?${q({ workspace: a.workspace, agent_id: a.agent_id, session_id: a.session_id, companion_agent_id: a.companion_agent_id, companion_loop_id: a.companion_loop_id, task_key: a.task_key, limit: a.limit })}`);
      if (a.action === 'schedule') return call('POST', '/subconscious/idea-scheduler', { workspace: a.workspace, agent_id: a.agent_id, session_id: a.session_id, foreground_agent_id: a.foreground_agent_id, companion_agent_id: a.companion_agent_id, companion_loop_id: a.companion_loop_id, task_key: a.task_key, source: a.source, title: a.title, idea: a.idea, reason: a.reason, parent_task_keys: a.parent_task_keys, context_task_keys: a.context_task_keys, approval_signals: a.approval_signals, approval_required: a.approval_required, payload: a.payload, confidence: a.confidence, now: a.now });
      return { error: 'action must be "schedule" or "read"' };
    } }
  ];
}

module.exports = subconsciousTools;
