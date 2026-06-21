// Shared MCP core: tool/resource definitions + JSON-RPC dispatch, used by BOTH transports —
// the stdio server (mcp-graph.js) and the daemon's HTTP /mcp endpoint (for custom connectors).
// Tools operate by calling the daemon's existing HTTP API via an injected `call(method,path,body)`.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const runtimePaths = require('./runtime-paths');

// Auth token: env ORCH_TOKEN, else BASE/token file, else null (auth off — back-compat).
function readToken() {
  if (process.env.ORCH_TOKEN) return process.env.ORCH_TOKEN.trim() || null;
  try { return fs.readFileSync(runtimePaths.runtimePath('token'), 'utf8').trim() || null; } catch { return null; }
}

const UI_URI = 'ui://orchestrator/graph';
const UI_MIME = 'text/html;profile=mcp-app';
const PORT = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
const DEFAULT_PROTOCOL = '2025-06-18';

const q = (o) => Object.entries(o).filter(([, v]) => v != null).map(([k, v]) => `${k}=${encodeURIComponent(v)}`).join('&');

function uiHtml() {
  try { return fs.readFileSync(path.join(__dirname, '..', 'public', 'inline.html'), 'utf8'); }
  catch { return '<!doctype html><body>inline.html missing</body>'; }
}

// An HTTP client bound to the daemon port — same for stdio (mcp-graph) and the daemon's self-calls.
// `workspace` (optional): the calling session's pinned workspace. When set it is injected into
// every POST (mutating) body so the daemon's graph-WRITE routes target THAT workspace instead of
// the daemon-global one (the workspace-gremlin fix), AND into every GET path as ?workspace= so the
// daemon's READ routes resolve THIS session's graph too (the read-side counterpart — without it,
// reads land on whatever workspace the daemon-global state last pinned, e.g. after a restart).
// The stdio server passes its ORCH_WORKSPACE/cwd; the daemon's self-call passes nothing =>
// unchanged fallback behavior. An explicit body.workspace / ?workspace= from a caller wins.
//
// RESTART RESILIENCE (two halves, both client-side here):
//   RETRY — a brief daemon restart must be invisible to in-flight tool calls. Retry ONLY on
//   connection-level failures where NO response was received (req 'error': ECONNREFUSED = the
//   request never arrived, always safe; ECONNRESET/EPIPE/"socket hang up" = it may or may not
//   have arrived). Bounded: RETRY_ATTEMPTS total, RETRY_BACKOFF_MS×attempt backoff. HTTP-level
//   errors (4xx/5xx — a response WAS received) are never retried; an error after the response
//   started surfaces on the response stream, not req 'error', so it is never retried either.
//   IDEMPOTENCY — a retried POST could duplicate a write that actually landed (reset after
//   delivery, before the response). Every mutating POST is stamped with ONE op_id (uuid) per
//   LOGICAL request, REUSED across its retries; the daemon's replay cache returns the recorded
//   response for a duplicate op_id instead of re-applying (see daemon.js opReplay/sendOp). An
//   explicit body.op_id from a caller wins (spread order).
const REQUEST_TIMEOUT_MS = 30000;
const RETRY_ATTEMPTS = 3;
const RETRY_BACKOFF_MS = 500;
const RETRYABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EPIPE']);
function makeCall(port, workspace) {
  return (method, p, body) => new Promise((resolve) => {
    let payload = (workspace && method === 'POST') ? { workspace, ...(body || {}) } : body;
    if (method === 'POST') payload = { op_id: crypto.randomUUID(), ...(payload || {}) };
    if (workspace && method === 'GET' && !/[?&]workspace=/.test(p)) p += (p.includes('?') ? '&' : '?') + `workspace=${encodeURIComponent(workspace)}`;
    const data = payload ? JSON.stringify(payload) : null;
    const headers = {};
    if (data) { headers['content-type'] = 'application/json'; headers['content-length'] = Buffer.byteLength(data); }
    const tok = readToken(); if (tok) headers['authorization'] = `Bearer ${tok}`;
    const attempt = (n) => {
      const req = http.request({ host: '127.0.0.1', port, path: p, method, headers },
        (res) => {
          const chunks = [];
          res.on('data', (c) => chunks.push(c));
          res.on('end', () => {
            const b = Buffer.concat(chunks).toString('utf8');
            let parsed; try { parsed = b ? JSON.parse(b) : {}; } catch { parsed = { raw: b }; }
            if (res.statusCode >= 400 && !(parsed && parsed.error)) parsed = { error: `daemon HTTP ${res.statusCode}`, status: res.statusCode, body: parsed };
            resolve(parsed);
          });
        });
      req.on('error', (e) => {
        if (RETRYABLE.has(e.code) && n < RETRY_ATTEMPTS) return setTimeout(() => attempt(n + 1), RETRY_BACKOFF_MS * n);
        resolve({ error: `daemon unreachable on :${port} (${e.code}). Is the orchestrator daemon running?` });
      });
      req.setTimeout(REQUEST_TIMEOUT_MS, () => {
        req.destroy();
        resolve({ error: 'request timed out' });
      });
      if (data) req.write(data); req.end();
    };
    attempt(1);
  });
}

const TOOLS = [
  { name: 'get_graph', description: 'Get the workspace task graph or a focused slice of it. Default scope "frontier" returns a lean digest that fits large graphs: whole-graph summary counts + the active frontier (ready/in_progress/recently-relevant nodes, their 1-hop neighbors, and weight-guided important deps/context providers) as slim nodes with clipped summaries. scope "all" returns the whole graph (statuses not_ready/ready/in_progress/tested/done/failed/canceled, ghosts, edges) — pair with compact:true for a slimmed projection (per task only id/label/status/deps/assignee), an order of magnitude smaller on a large graph. scope "adjacent" (requires task_key) returns one task plus its immediate neighbourhood: dependencies, cross-workspace ghost dependencies, and dependents. scope "tree" (requires task_key; optional depth) walks VERTICALLY up the task\'s dependency chain (transitive deps) returning each ancestor with summary + depth — ghost deps come back as a frontier (use peek_workspace). For frontier/all: stale done/canceled tasks and superseded notes older than the archive window are swept from the payload (summary.archived counts them) unless include_archived:true — they always stay queryable via search_knowledge/suggest_links.', inputSchema: { type: 'object', properties: { scope: { type: 'string', enum: ['frontier', 'all', 'adjacent', 'tree'], description: 'frontier (default) = lean active-frontier digest; all = whole graph; adjacent = one task + 1-hop neighbourhood (requires task_key); tree = transitive dependency ancestors (requires task_key, optional depth).' }, compact: { type: 'boolean' }, include_archived: { type: 'boolean' }, task_key: { type: 'string' }, depth: { type: 'number' } }, additionalProperties: false }, run: (a, call) => {
      const scope = (a && a.scope) || 'frontier';
      if (scope === 'adjacent' || scope === 'tree') {
        if (!a || !a.task_key) return { error: `scope "${scope}" requires task_key` };
        return scope === 'adjacent' ? call('GET', `/task/adjacent?${q({ key: a.task_key })}`) : call('GET', `/task/tree?${q({ key: a.task_key, depth: a.depth })}`);
      }
      return call('GET', `/state?${q({ scope, compact: a && a.compact ? 1 : null, include_archived: a && a.include_archived ? 1 : null })}`);
    } },
  { name: 'start_task', description: 'Claim a task and mark it in_progress. WORKERS ONLY — dispatchers must NOT call start_task. REQUIRED ORDER: call branch_task(task_key) FIRST to create an isolated worktree, THEN call start_task — the daemon rejects with 409 if no worktree is registered. Pass session_id (caller conversation/session id) — required for the claim gate. Safe-claim (CAS): refuses (409) if task is "canceled" or already in_progress by a DIFFERENT agent. Pass force:true only for a deliberate takeover.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, agent_id: { type: 'string' }, session_id: { type: 'string', description: 'Caller session/conversation id. Optional in schema but required for the claim gate — workers must pass it.' }, force: { type: 'boolean' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/status', { key: a.task_key, status: 'in_progress', agent_id: a.agent_id, session_id: a.session_id, force: a.force }) },
  { name: 'complete_task', description: 'Mark a task done and record a CONCISE summary (the interface other tasks pull as cheap base context). Keep it short. OPTIONAL follow_ups: STRUCTURAL follow-up work you discovered ("daemon needs restart", "backfill out of scope") — do not leave such items as prose in the summary; nothing acts on prose. Each item becomes a graph task wired to this task by a context edge (it inherits your summary as Tier-1 context). Routing per item: no `when` or "asap" → ready now, the heartbeat loop picks it up; future ISO `when` → a one-time native scheduled task fires it then; disruptive:true (restarts/deploys/destructive ops) → queued for user approval via the guidance gate and held not_ready until approved. The prompt MUST be self-contained — the executing session has no memory of yours. OPTIONAL verdicts: structured judgments about EXISTING tasks your work reached a conclusion on ("GO on X", "X must stay held", "Y is moot") — never leave a verdict in prose; nothing acts on prose. Each item {task_key, action, reason}: action "release" drops the target\'s explicit not_ready hold so its status re-derives from deps; "hold" sets/refreshes a not_ready hold; "cancel" cancels it (terminal + cooperative cancel flag); "merge" records a non-destructive merge request for merge_attempt/merge_feature handling. The reason lands in the target\'s note.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, summary: { type: 'string' }, agent_id: { type: 'string' }, task_result: { type: 'object', description: 'Optional structured result envelope forwarded to the daemon for task-result validation.', additionalProperties: true }, follow_ups: { type: 'array', description: 'Optional structural follow-ups the daemon acts on automatically.', items: { type: 'object', properties: { title: { type: 'string', description: 'Short imperative label for the follow-up task.' }, prompt: { type: 'string', description: 'Self-contained instructions a cold session can execute (include paths/context).' }, when: { type: 'string', description: 'ISO 8601 timestamp to run at, or "asap" (default: immediate).' }, disruptive: { type: 'boolean', description: 'true for restarts/deploys/destructive ops — routes through the user-approval gate instead of auto-firing.' } }, required: ['title', 'prompt'], additionalProperties: false } }, verdicts: { type: 'array', description: 'Optional structured verdicts about existing tasks the daemon enforces.', items: { type: 'object', properties: { task_key: { type: 'string', description: 'The existing task this verdict is about.' }, action: { type: 'string', enum: ['release', 'hold', 'cancel', 'merge'], description: 'release = drop its explicit not_ready hold (status re-derives from deps); hold = set/refresh a not_ready hold; cancel = cancel it; merge = record a non-destructive merge request.' }, reason: { type: 'string', description: 'Why — recorded on the target task\'s note.' } }, required: ['task_key', 'action', 'reason'], additionalProperties: false } } }, required: ['task_key', 'summary'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/status', { key: a.task_key, status: 'done', summary: a.summary, agent_id: a.agent_id, task_result: a.task_result, follow_ups: a.follow_ups, verdicts: a.verdicts }) },
  { name: 'set_status', description: 'Set the overlay status for a task. Allowed: in_progress, tested, done, failed, canceled (also not_ready/ready, normally derived). Prefer start_task/complete_task. Concurrency: pass expected_status to compare-and-set (409 if the status changed under you). "canceled" is terminal — leaving it (e.g. back to in_progress) needs force:true. Setting "canceled" also raises a cooperative cancel flag (see get_task_detail.cancel_requested).', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, status: { type: 'string', enum: ['not_ready', 'ready', 'in_progress', 'tested', 'done', 'failed', 'canceled'] }, note: { type: 'string' }, expected_status: { type: 'string' }, force: { type: 'boolean' } }, required: ['task_key', 'status'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/status', { key: a.task_key, status: a.status, note: a.note, expected_status: a.expected_status, force: a.force }) },
  { name: 'get_dependency_summaries', description: 'TIER 1 (cheap, do first): concise summaries of a task\'s dependencies — enough to start without loading full context. Blocking deps are listed first (no weight). Context deps include a relevance weight (0..1, default 0.5) from wired context edges and are sorted highest-first.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('GET', `/task/context?${q({ key: a.task_key })}`) },
  { name: 'get_task_detail', description: 'TIER 2 (on demand): full detail for one task — knowledge items, summary, assigned agent, token usage, transcript pointer.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('GET', `/task/detail?${q({ key: a.task_key })}`) },
  { name: 'get_judge_next', description: 'Fetch pending judge items from /judge/next. Pass node to actively resolve a task\'s judging hold before retrying start_task; this only exposes the existing judge queue and does not auto-approve edges.', inputSchema: { type: 'object', properties: { node: { type: 'string', description: 'Optional node/task key for /judge/next?node=...' }, budget: { type: 'number' } }, additionalProperties: false }, run: (a, call) => call('GET', `/judge/next?${q({ node: a && a.node, budget: a && a.budget })}`) },
  { name: 'submit_judge_verdict', description: 'Submit explicit judge verdicts to /judge/verdict. Use keepEdge/pruneEdge verdicts returned from get_judge_next to clear a judging hold, then retry start_task; start_task still enforces the hold until these verdicts drain it or the timeout fallback fires.', inputSchema: { type: 'object', properties: { verdicts: { type: 'array', items: { type: 'object', additionalProperties: true } }, keepEdge: { type: 'object', additionalProperties: true }, pruneEdge: { type: 'object', additionalProperties: true }, createEdge: { type: 'object', additionalProperties: true }, consolidate: { type: 'object', additionalProperties: true }, surfaceCluster: { type: 'object', additionalProperties: true }, markJudged: { type: 'string' }, item: { type: 'object', additionalProperties: true } }, additionalProperties: false }, run: (a, call) => {
    const body = a || {};
    if (!Array.isArray(body.verdicts) && !body.keepEdge && !body.pruneEdge && !body.createEdge && !body.consolidate && !body.surfaceCluster && !body.markJudged && !body.item) return { error: 'pass at least one judge verdict' };
    return call('POST', '/judge/verdict', body);
  } },
  { name: 'attach_knowledge', description: 'Attach a Tier-2 knowledge item to a task. item = { type: "file"|"snippet"|"link"|"note", value, ... }.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, item: { type: 'object' } }, required: ['task_key', 'item'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/knowledge', { key: a.task_key, item: a.item }) },
  { name: 'record_decision', description: "Capture a durable decision, rationale, or finding from the conversation as a NOTE node in the graph (NOT a todo). It becomes Tier-1 context for related future tasks via context edges + suggest_links. Use when a turn produces lasting knowledge, or when the user says 'remember this'. TEMPORAL: when this decision REPLACES an earlier one, pass `supersedes` (the old note's key) — the old note is stamped invalid (validTo) and kept as history, not deleted, so as-of retrieval can still recover what was true before. `valid_from` (ISO) optionally backdates when this fact became true. CONTRADICTION CHECK: before recording, call search_knowledge for related CURRENT notes. If the new finding clearly contradicts/replaces one, pass `supersedes` with that note's key so the stale note is retired in the same call. If the contradiction is uncertain, do NOT supersede — mention the tension in the summary instead. DUPLICATE GUARD: if the response is { ok:false, duplicate:true, match:{key,title,summary,score} }, a near-identical note already exists — choose: skip (same fact, nothing to add), re-call with supersedes:match.key (this note updates the fact), or re-call with force:true (genuinely distinct, record anyway).", inputSchema: { type: 'object', properties: { title: { type: 'string' }, summary: { type: 'string' }, category: { type: 'string' }, tags: { type: 'array', items: { type: 'string' } }, knowledge: { type: 'array' }, supersedes: { type: 'string' }, valid_from: { type: 'string' }, wires_to: { type: 'array', items: { type: 'string' }, description: 'Task keys this note was discovered during. Creates explicit DAG context edges (always injects, no gate needed). Pass the current task key when creating a note while working a task.' } }, required: ['title', 'summary'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/note', { title: a.title, summary: a.summary, category: a.category, tags: a.tags, knowledge: a.knowledge, supersedes: a.supersedes, valid_from: a.valid_from, wires_to: a.wires_to, created_by: 'main' }) },
  { name: 'supersede_note', description: 'Mark an existing note (a recorded decision/finding) as superseded by a newer one WITHOUT deleting history: stamps the old note invalid-from the changeover instant and chains old↔new. The newer fact then wins in default search_knowledge, while as-of retrieval can still recover the older fact for a past timestamp. Both notes must already exist (keys like "note:<id>"). Use when a later decision invalidates an earlier recorded one.', inputSchema: { type: 'object', properties: { old_key: { type: 'string' }, new_key: { type: 'string' }, at: { type: 'string' } }, required: ['old_key', 'new_key'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/note/supersede', { old_key: a.old_key, new_key: a.new_key, at: a.at }) },
  {
    name: 'create_gate',
    description: 'Create a gate node — a coordination primitive that blocks a task until an external event satisfies it (daemon restart, commit, human approval). The dispatcher calls this when wiring the DAG; workers do not. The gate is automatically completed by the daemon when the satisfying event occurs (e.g. daemon-restart gates are swept on every boot). kind: "daemon-restart" | "main-commit" | "human-approval".',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['daemon-restart', 'main-commit', 'human-approval'] },
        blocking_task_key: { type: 'string', description: 'The task that must wait for this gate to be satisfied.' },
      },
      required: ['kind', 'blocking_task_key'],
      additionalProperties: false,
    },
    run: (a, call) => call('POST', '/overlay/gate', { kind: a.kind, blocking_task_key: a.blocking_task_key, created_by: 'dispatcher' }),
  },
  { name: 'add_dependency', description: 'Add a dependency edge. kind:"blocking" (default) = `to` is blocked by `from` (true prerequisite). kind:"context" = non-blocking link so `from`\'s summary flows into `to` as Tier-1 context EVEN IF `from` is already done (use to wire a new task to relevant existing/completed work). weight (0..1, context edges only) = optional relevance scalar for relevance-ordered traversal; omit ⇒ default. For a CROSS-WORKSPACE ghost edge set from_workspace to the provider\'s absolute path.', inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, from_workspace: { type: 'string' }, kind: { type: 'string', enum: ['blocking', 'context'] }, weight: { type: 'number' } }, required: ['from', 'to'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/edge', { from: a.from, to: a.to, fromWorkspace: a.from_workspace, kind: a.kind, weight: a.weight }) },
  { name: 'mark_root', description: 'Declare a task a genuine root (no prerequisites, no context providers). Clears the unwired quarantine so it can be claimed. Use ONLY when the task truly relates to nothing existing.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, reason: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('POST', '/mark-root', { task_key: a.task_key, reason: a.reason }) },
  { name: 'remove_dependency', description: 'Remove a dependency edge from -> to (idempotent). Pass kind:"blocking"|"context" to remove only that kind; omit to remove every edge between them. For a CROSS-WORKSPACE ghost edge set from_workspace to the provider\'s absolute path. Use to re-parallelize a graph by dropping a stale prerequisite.', inputSchema: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, from_workspace: { type: 'string' }, kind: { type: 'string', enum: ['blocking', 'context'] } }, required: ['from', 'to'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/edge/remove', { from: a.from, to: a.to, fromWorkspace: a.from_workspace, kind: a.kind }) },
  { name: 'list_agents', description: 'List every known agent across sessions with its task, session, workspace, startedAt and current cooperative-stop flag. Use to SEE whether another session has a worker running on this graph before you act.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: (a, call) => call('GET', '/agents') },
  { name: 'request_agent_stop', description: 'Cooperatively stop a worker by agent_id, or by task_key (resolved via its assignee). Sets an advisory stop flag — there is NO cross-process kill; the worker is expected to poll list_agents (or /agent/stop-requested) and self-terminate. Use to stand down a colliding worker in another session.', inputSchema: { type: 'object', properties: { agent_id: { type: 'string' }, task_key: { type: 'string' } }, additionalProperties: false }, run: (a, call) => call('POST', '/agent/stop', { agent_id: a.agent_id, task_key: a.task_key }) },
  { name: 'suggest_links', description: 'Suggest existing tasks (INCLUDING completed ones) that a task should link to, ranked by label+summary overlap. Call right after creating a task: link DONE matches as kind:"context" so their summaries become context, and true prerequisites as kind:"blocking" — this stops new tasks from piling up as disconnected root nodes.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('GET', `/task/suggest?${q({ key: a.task_key })}`) },
  { name: 'enqueue_kb', description: 'Mine a repo and enqueue ALL candidates into the learner queue (no cap, no LLM). Fast first step before drain_kb_batch. Pass outDir to override the default bench/onboard/<repo-name> location.', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, outDir: { type: 'string' } }, required: ['repo'], additionalProperties: false }, run: (a, call) => call('POST', '/onboard/enqueue', { repo: a.repo, outDir: a.outDir }) },
  { name: 'drain_kb_batch', description: 'Process one batch of queued KB candidates via LLM. Call repeatedly until status.done is true, then review the generated onboard-notes.json and call inject_kb to push approved notes into the graph. Returns { ok, status: { total, processed, remaining, done, kept } }.', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, outDir: { type: 'string' }, batchSize: { type: 'number' } }, required: ['repo', 'outDir'], additionalProperties: false }, run: (a, call) => call('POST', '/onboard/drain-next', { repo: a.repo, outDir: a.outDir, batchSize: a.batchSize }) },
  { name: 'drain_kb_queue', description: 'Fire-and-forget background drain: kicks off the full queue drain in the daemon background. Default is human-gated: when done, review onboard-notes.json and call inject_kb explicitly. Pass autoInject:true only for trusted automation that should run --inject --confirm on completion. Poll with drain_kb_queue_status to check progress.', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, outDir: { type: 'string' }, batchSize: { type: 'number' }, autoInject: { type: 'boolean', description: 'Opt in to automatic graph injection after drain completion. Defaults to false.' } }, required: ['repo', 'outDir'], additionalProperties: false }, run: (a, call) => call('POST', '/onboard/drain-queue', { repo: a.repo, outDir: a.outDir, batchSize: a.batchSize, autoInject: a.autoInject }) },
  { name: 'drain_kb_queue_status', description: 'Get the current status of a background drain job started by drain_kb_queue. Returns { ok, status: { repo, outDir, total, processed, remaining, done, error, needsReview, injected } }.', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, outDir: { type: 'string' } }, required: ['repo', 'outDir'], additionalProperties: false }, run: (a, call) => call('GET', `/onboard/drain-queue?${new URLSearchParams({ repo: a.repo, outDir: a.outDir })}`) },
  { name: 'inject_kb', description: 'Explicitly inject reviewed onboarding KB notes into the graph for a repo/outDir. This is the human-gated counterpart to scripts/onboard-learn.js --inject --confirm.', inputSchema: { type: 'object', properties: { repo: { type: 'string' }, outDir: { type: 'string' } }, required: ['repo', 'outDir'], additionalProperties: false }, run: (a, call) => call('POST', '/onboard/inject', { repo: a.repo, outDir: a.outDir }) },
  { name: 'get_learnings', description: "Aggregate the graph's accumulated learning (attempt verdicts, recent failures, recent completions) — the digest a planner reads to decide what to try next. Pass compact:true for a lean payload (trimmed verdicts + rejected ledger only, recent/failures dropped) to cut re-attended context cost.", inputSchema: { type: 'object', properties: { compact: { type: 'boolean' } }, additionalProperties: false }, run: (a, call) => call('GET', a.compact ? '/learnings?compact=1' : '/learnings') },
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
      anyOf: [{ required: ['intent'] }, { required: ['situation'] }, { required: ['query'] }],
      additionalProperties: false,
    },
    run: (a, call) => call('POST', '/subconscious/ask', {
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
    }),
  },
  { name: 'subconscious_execution_permit', description: 'Issue, read, or revoke a scoped Subconscious execution permit for foreground writes. A permit is external write authority bound to session_id, task_key, worktree, branch, optional agent identities, expiration, and allowed path scope; the write gate still validates it against the active task claim/worktree.', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['issue', 'read', 'revoke'], description: 'issue = create a scoped permit; read = fetch the latest matching permit; revoke = revoke the latest matching permit or permit_id.' }, workspace: { type: 'string', description: 'Workspace path. Defaults to the session workspace when omitted by the transport.' }, permit_id: { type: 'string' }, session_id: { type: 'string' }, agent_id: { type: 'string' }, foreground_agent_id: { type: 'string' }, task_key: { type: 'string' }, worktree: { type: 'string' }, branch: { type: 'string' }, scope: { type: 'string', enum: ['worktree', 'repo', 'paths'] }, allowed_paths: { type: 'array', items: { type: 'string' } }, expires_at: { type: 'string' }, ttl_seconds: { type: 'number' }, ttl_ms: { type: 'number' }, reason: { type: 'string' }, payload: {}, now: { type: 'string' } }, required: ['action'], additionalProperties: false }, run: (a, call) => {
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
    } },
  { name: 'search_knowledge', description: 'Lower-level knowledge retrieval primitive for explicit lookup and internal Subconscious use. Foreground agents that need a verdict, prediction, context, anchor, pressure, or approval posture should call ask_subconscious first. For direct retrieval, gated mode with `task_key` returns the same ranked top-k bundle as ungated plus gate metadata: decision:"inject" means the flagged result cleared the context-need gate; decision:"abstain" means nothing cleared auto-inject but ranked results are still visible. Ungated mode returns ranked hits without gate metadata. First gated call may take up to ~90s while the local embedding model lazy-loads. TEMPORAL/AS-OF: by default returns only facts CURRENT now (superseded notes are hidden). Pass `as_of` (ISO timestamp) to get the fact that was current AT THAT TIME, or `history:true` to include superseded notes. TIERED: pass `task_key` to include DAG context_deps first, then RAG fills remaining slots. ITERATIVE: `continue:true` means another reformulated query may surface more relevant notes; pass `exclude_keys` and increment `round` up to 3.', inputSchema: { type: 'object', properties: { query: { type: 'string' }, k: { type: 'number' }, gated: { type: 'boolean' }, as_of: { type: 'string' }, history: { type: 'boolean' }, task_key: { type: 'string' }, exclude_keys: { type: 'array', items: { type: 'string' }, description: 'Note keys already injected in prior rounds — excluded from candidates before ranking.' }, round: { type: 'number', description: 'Retrieval round (1-based, default 1). Rounds >= 3 always return continue:false.' }, complexity: { type: 'number', description: 'Prompt complexity score (0–1) from the model-routing hook. Passed to the gate journal as a task-side feature. Omit if unknown.' } }, required: ['query'], additionalProperties: false }, run: (a, call) => call('GET', `/search?${q({ q: a.query, k: a.k, gated: a.gated ? 1 : undefined, asOf: a.as_of, history: a.history ? 1 : undefined, task_key: a.task_key, exclude_keys: Array.isArray(a.exclude_keys) && a.exclude_keys.length ? a.exclude_keys.join(',') : undefined, round: a.round, complexity: a.complexity })}`) },
  { name: 'entity_context', description: 'Query everything known (conversational facts) AND everything done (tasks) about a named entity. Returns facts (note nodes distilled from conversation or hand-authored) and tasks (execution nodes) wired to this entity in a single unified view — the entity is the join key across both graphs. Use to answer "what do we know about X and what have we done with X?" without separate searches. Pass as_of (ISO timestamp) to see only facts that were current at that time.', inputSchema: { type: 'object', properties: { entity_name: { type: 'string', description: 'The entity name to look up (case-insensitive exact match against registered entity nodes).' }, workspace: { type: 'string', description: 'Workspace path. Defaults to the session workspace when omitted.' }, as_of: { type: 'string', description: 'Optional ISO timestamp — filter facts to only those valid at this point in time.' } }, required: ['entity_name'], additionalProperties: false }, run: async (a, call) => {
    const lookupResp = await call('GET', `/entity?${q({ name: a.entity_name, workspace: a.workspace })}`);
    if (!lookupResp || lookupResp.error) {
      return { ok: false, error: lookupResp ? lookupResp.error : 'entity lookup failed', entity_name: a.entity_name };
    }
    const entityId = lookupResp.id;
    return call('GET', `/entity/${encodeURIComponent(entityId)}/context?${q({ workspace: a.workspace, asOf: a.as_of })}`);
  } },
  { name: 'graph_delta', description: "What changed in the graph since an ISO-8601 timestamp — the read-only change sensor for nightly-QA / catch-up sweeps. Returns { since, now, counts, status_changes (tasks whose status changed after T, incl. reached done/tested/canceled), tasks_created, notes_added (decisions/findings recorded after T), merges (judge/merge verdicts that carry a timestamp; timestamp-less verdicts are omitted) }. Derived purely from existing timestamps — never mutates the graph.", inputSchema: { type: 'object', properties: { since: { type: 'string', description: 'ISO-8601 timestamp, e.g. 2026-06-09T00:00:00Z' } }, required: ['since'], additionalProperties: false }, run: (a, call) => call('GET', `/graph/delta?${q({ since: a.since })}`) },
  { name: 'next_action', description: 'HEARTBEAT (drives the WHOLE loop registry in ONE call): returns { loops: [ { loopId, action: spawn|idle|judge_eager|judge_edges|plan|stop|await_user, tasks?, nodes?, next_poll_seconds?, budget_remaining } ] } — one entry per ACTIVE loop. Fan out spawns per loopId; reschedule ONE wakeup at the MIN next_poll_seconds across active loops; the whole heartbeat is done only when every entry reports stop. action:plan means that loop drained but self-planning is on.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: (a, call) => call('GET', '/next-action') },
  { name: 'loop_control', description: 'Manage heartbeat loops — ONE tool, action: "start" | "stop" | "status". action:"start": start a loop and INSERT it into the registry (never clobbers an existing loop) — pass explicit token controls (tokenBudget, maxIterations, minPoll, maxPoll, estPerTick, batch) and an optional `session` (the driving conversation, so a cooperative-stop on its claimed task halts THIS loop within one tick); optional `loopId` restarts that specific loop in place, otherwise the daemon mints a UUID; returns { ok, loopId, loop }; hard caps. action:"stop": stop a specific loop — `loopId` REQUIRED; returns { ok, loopId }. action:"status": read loop state — with `loopId`, that loop\'s entry { active, iterations, spent, budget, config, ... }; omit loopId for the whole registry { loops: { [loopId]: entry } }. Token-control params and `session` apply ONLY to action:"start".', inputSchema: { type: 'object', properties: { action: { type: 'string', enum: ['start', 'stop', 'status'], description: '"start" = insert a new loop (or restart in place with loopId); "stop" = stop one loop (loopId required); "status" = one loop or, without loopId, the whole registry.' }, loopId: { type: 'string', description: 'start: optional, restarts this loop in place; stop: REQUIRED; status: optional, omit for all loops.' }, tokenBudget: { type: 'number' }, maxIterations: { type: 'number' }, minPoll: { type: 'number' }, maxPoll: { type: 'number' }, estPerTick: { type: 'number' }, batch: { type: 'number' }, session: { type: 'string' } }, required: ['action'], additionalProperties: false }, run: (a, call) => { const { action, ...rest } = a; if (action === 'stop') return rest.loopId ? call('POST', '/loop/stop', { loopId: rest.loopId }) : { error: 'loopId is required for action:"stop"' }; if (action === 'status') return call('GET', rest.loopId ? `/loop/status?loopId=${encodeURIComponent(rest.loopId)}` : '/loop/status'); return call('POST', '/loop/start', rest); } },
  { name: 'peek_workspace', description: 'Load another workspace\'s full task graph on demand (does not change current). Inspect a ghost dependency\'s source.', inputSchema: { type: 'object', properties: { workspace: { type: 'string' } }, required: ['workspace'], additionalProperties: false }, run: (a, call) => call('GET', `/peek?${q({ workspace: a.workspace })}`) },
  { name: 'configure_task', description: 'Configure a task\'s execution settings in ONE call (replaces set_task_repo / set_repo_test_cmd / set_task_metric / set_task_benchmark). Pass task_key plus ANY of the optional fields; each provided field is applied in order (repo_path → test_cmd → metric → benchmark) with per-field results. Omitted fields are untouched. FIELDS: `repo_path` (string; clear with "") = REPO TARGETING — the TARGET git repo path the task\'s git ops (branch_task / merge_attempt / remove_worktree / measure_task) run against when it differs from the daemon workspace; persisted on the task node, resolution order: explicit repo_path arg > this task field > workspace. `test_cmd` (string; clear with ""; requires `repo_path` in the same call since test commands are keyed by ABSOLUTE repo path) = STORED TEST COMMAND — how that repo\'s test suite is run (e.g. "npm test"); STORE/RETRIEVE ONLY: the daemon never executes it, agents (e.g. the nightly QA loop) read it back (as `test_cmd` on get_task_detail for tasks whose repo matches) and run it themselves. `metric` (object; clear with {}) = INLINE METRIC SPEC the task/problem node is optimizing, for the metric-driven loop: { metric (objective name/label), direction ("min"|"max"), measure_command (shell command run later in the attempt worktree that emits the metric), parse? (e.g. a regex or "last_number"), target? (threshold), guardrails? (array of { metric, direction, measure_command, parse? } that must-not-regress) }; validated server-side (metric/direction/measure_command required, direction ∈ {min,max}); surfaces as `metric` on the node + /task/detail so the measure node and judge can read it. `benchmark` (object; clear with {}) = EXTERNAL BENCHMARK — the researched competitor/industry-average reference the judge compares the winning attempt\'s measured value against, beyond our own baseline: { metric (must name the same objective as the metric spec), value (number), unit? (e.g. "ms"), source (string/url for provenance), note?, confidence? ("low"|"med"|"high"), researched_at? }; validated server-side (metric/value/source required, confidence ∈ {low,med,high}); surfaces as `benchmark` on the node + /task/detail; absent ⇒ baseline-only judging.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, repo_path: { type: 'string' }, test_cmd: { type: 'string' }, metric: { type: 'object' }, benchmark: { type: 'object' } }, required: ['task_key'], additionalProperties: false }, run: async (a, call) => {
    const results = {}; let any = false, failed = false;
    const apply = async (field, fn) => { any = true; const r = await fn(); results[field] = r; if (r && r.error) failed = true; };
    if (a.repo_path !== undefined) await apply('repo_path', () => call('POST', '/git/repo', { key: a.task_key, repo_path: a.repo_path }));
    if (a.test_cmd !== undefined) await apply('test_cmd', () => a.repo_path ? call('POST', '/config', { test_cmds: { [a.repo_path]: a.test_cmd || '' } }) : Promise.resolve({ error: 'test_cmd requires repo_path in the same call (test commands are keyed by absolute repo path)' }));
    if (a.metric !== undefined) await apply('metric', () => call('POST', '/task/metric', { key: a.task_key, spec: a.metric }));
    if (a.benchmark !== undefined) await apply('benchmark', () => call('POST', '/task/benchmark', { key: a.task_key, benchmark: a.benchmark }));
    if (!any) return { error: 'nothing to configure — pass at least one of repo_path, test_cmd, metric, benchmark' };
    return failed ? { ok: false, error: 'one or more fields failed — see results', results } : { ok: true, results };
  } },
  { name: 'measure_task', description: 'Run the task\'s inline metric spec and store the measured value(s) on the node — the MEASURE half of the metric-driven loop. Runs measure_command (+ each guardrail) in the attempt\'s git worktree (branch_task) and parses a number via the spec\'s `parse`. Pass baseline:true to instead measure the repo\'s current main (repo root, no attempt) and store it as the judge\'s reference. Targets the task\'s repo (configure_task repo_path) or repo_path, else the workspace. Requires a metric spec (configure_task metric) and a git repo (branch_task auto-inits one). Result surfaces as `measurement` on the node + /task/detail.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, baseline: { type: 'boolean' }, repo_path: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('POST', '/task/measure', { key: a.task_key, baseline: a.baseline, repo_path: a.repo_path }) },
  { name: 'branch_task', description: 'Create an isolated git worktree + branch (orch/attempt/<key>) for a task attempt, recorded on the task node. The foundation of side-by-side experiment isolation. Targets the task\'s repo (configure_task repo_path) or repo_path, else the workspace. If the target repo is not a git repo yet, it is initialized automatically first.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, repo_path: { type: 'string' }, base: { type: 'string', description: 'Git ref to branch from (default: HEAD)' } }, required: ['task_key'], additionalProperties: false }, run: async (a, call) => {
    // Auto-init: if the target isn't a git repo yet, hit the same /git/init endpoint the old
    // standalone git_init tool used, so the prerequisite is implicit.
    const st = await call('GET', `/git/status?${q({ key: a.task_key, repo_path: a.repo_path })}`);
    if (st && !st.error && !st.isRepo) {
      const init = await call('POST', '/git/init', { key: a.task_key, repo_path: a.repo_path });
      if (init && init.error) return init;
    }
    return call('POST', '/git/worktree', { key: a.task_key, repo_path: a.repo_path, base: a.base });
  } },
  { name: 'remove_worktree', description: 'Remove a task attempt\'s git worktree and delete its branch (idempotent cleanup). Targets the task\'s repo (configure_task repo_path) or repo_path, else the workspace.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, repo_path: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('POST', '/git/worktree/remove', { key: a.task_key, repo_path: a.repo_path }) },
  { name: 'merge_attempt', description: 'Merge a winning attempt\'s branch (orch/attempt/<key>) back into the base. Returns {merged} or {conflict, files}. The merge half of the judge/merge-back loop. Targets the task\'s repo (configure_task repo_path) or repo_path, else the workspace.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, repo_path: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('POST', '/git/merge', { key: a.task_key, repo_path: a.repo_path }) },
  { name: 'create_feature', description: 'Create the FEATURE-tier integration surface — a long-lived feature branch (orch/feature/<feature_key>) + worktree branched off `base` (default main). This is the tier-1 surface workers integrate into: dispatch attempts with branch_task(base=<orch/feature/...>, repo_path=<feature worktree>) so each attempt forks FROM the feature branch, and merge_attempt(repo_path=<feature worktree>) lands the winner INTO the feature branch (cheap, frequent), NOT into main. Targets the feature key\'s repo (configure_task repo_path) or repo_path, else the workspace; auto-inits the repo if needed. Idempotent. Returns { branch, worktree, head, repo }.', inputSchema: { type: 'object', properties: { feature_key: { type: 'string' }, repo_path: { type: 'string' }, base: { type: 'string', description: 'Git ref to branch the feature off (default: main)' } }, required: ['feature_key'], additionalProperties: false }, run: async (a, call) => {
    const st = await call('GET', `/git/status?${q({ key: a.feature_key, repo_path: a.repo_path })}`);
    if (st && !st.error && !st.isRepo) {
      const init = await call('POST', '/git/init', { key: a.feature_key, repo_path: a.repo_path });
      if (init && init.error) return init;
    }
    return call('POST', '/feature/create', { key: a.feature_key, repo_path: a.repo_path, base: a.base });
  } },
  { name: 'merge_feature', description: 'GATED tier-2 step: merge a feature branch (orch/feature/<feature_key>) into main with --no-ff. Returns {merged} or {conflict, files} (auto-aborts to a clean tree on conflict). THIS IS A DISPATCHER DECISION ONLY — the consequential feature->main promotion. Do NOT call it from any auto/heartbeat/loop/judge path; the loop only auto-merges ATTEMPTS into the feature branch (tier-1, merge_attempt), never feature->main. Invoke this exactly once when a human/dispatcher decides the integrated feature is ready to land on main. Targets the feature key\'s repo (configure_task repo_path) or repo_path, else the workspace.', inputSchema: { type: 'object', properties: { feature_key: { type: 'string' }, repo_path: { type: 'string' } }, required: ['feature_key'], additionalProperties: false }, run: (a, call) => call('POST', '/feature/merge', { key: a.feature_key, repo_path: a.repo_path }) },
  { name: 'get_attempt_diff', description: 'Read-only: the diff of an attempt\'s branch (orch/attempt/<key>) against its base, so the judge can review the code an attempt changed. Returns { ok, key, branch, base, stat, diff } where stat is `git diff base...branch --stat` and diff is the full three-dot (merge-base) diff. Targets the task\'s repo (configure_task repo_path) or repo_path, else the workspace.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, repo_path: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('GET', `/attempt/diff?${q({ key: a.task_key, repo_path: a.repo_path })}`) },
  { name: 'request_guidance', description: 'LAST RESORT escalation — predict-by-default from KB first, only call this on a gate miss. The seam ENFORCES it: every call is run through the ask-vs-predict gate over recalled user-preference notes BEFORE reaching the user, so a confident project-local preference match auto-resolves the question (returns predicted:true + the answer) without ever pausing the loop or queuing for you. Only when no confident preference matches (gate says "ask") does this actually halt the loop and ask the user (ambiguous intent, irreversible/outward action, low-confidence high-impact, repeated failure, scope expansion). Irreversible/outward/high-impact/scope-expansion/repeated-failure decisions ALWAYS escalate (the gate hard-overrides prediction) — pass the matching flag or rely on keyword detection. severity defaults to "blocking" (pauses the loop); pass "review" ONLY for low-stakes housekeeping confirmations that should queue without pausing.', inputSchema: { type: 'object', properties: { question: { type: 'string' }, context: { type: 'string' }, trigger: { type: 'string' }, severity: { type: 'string', enum: ['blocking', 'review'] }, session_id: { type: 'string', description: 'Caller session/conversation id — injected by the seam to bind this escalation to the claiming task (origin_task) for the staleness sweep.' }, irreversible: { type: 'boolean' }, outward: { type: 'boolean' }, highImpact: { type: 'boolean' }, scopeExpansion: { type: 'boolean' }, repeatedFailure: { type: 'boolean' } }, required: ['question'], additionalProperties: false }, run: (a, call) => call('POST', '/guidance', { question: a.question, context: a.context, trigger: a.trigger, severity: a.severity, session_id: a.session_id, irreversible: a.irreversible, outward: a.outward, highImpact: a.highImpact, scopeExpansion: a.scopeExpansion, repeatedFailure: a.repeatedFailure }) },
  { name: 'list_guidance', description: 'List unresolved guidance questions the loop is currently waiting on the user to answer.', inputSchema: { type: 'object', properties: {}, additionalProperties: false }, run: (a, call) => call('GET', '/guidance') },
  { name: 'ask_gate', description: 'Decide ASK-the-user vs PREDICT-from-KB for a pending decision. The daemon recalls stored user-preference notes (semantic match, grounded on category:"preference" + general decision notes) and runs the ask-by-default heuristic gate (lib/ask-gate.js): a high-confidence, specific, project-local preference match returns decision:"predict" WITH the matched note; otherwise decision:"ask" (escalate via request_guidance). Decisions that are irreversible/outward-facing/high-impact/scope-expansion/repeated-failure ALWAYS return "ask" — pass the matching flag, or rely on conservative keyword detection on the decision text. Every verdict is journaled to .graph/ask-journal.jsonl.', inputSchema: { type: 'object', properties: { decision: { type: 'string', description: 'The pending decision/question you would otherwise ask the user.' }, irreversible: { type: 'boolean' }, outward: { type: 'boolean' }, highImpact: { type: 'boolean' }, scopeExpansion: { type: 'boolean' }, repeatedFailure: { type: 'boolean' } }, required: ['decision'], additionalProperties: false }, run: (a, call) => call('POST', '/ask-gate', { decision: a.decision, irreversible: a.irreversible, outward: a.outward, highImpact: a.highImpact, scopeExpansion: a.scopeExpansion, repeatedFailure: a.repeatedFailure }) },
  { name: 'block_task', description: 'Explicitly block a task from being auto-dispatched by the heartbeat loop. A blocked task stays out of the spawn queue regardless of its dep status — the block is sticky and survives graph rebuilds. Use to gate expensive or risky tasks that should not run without explicit approval. Call unblock_task to release. The block is visible on get_task_detail and in the graph.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' }, reason: { type: 'string', description: 'Why this task is blocked (stored for observability).' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/block', { key: a.task_key, reason: a.reason }) },
  { name: 'unblock_task', description: 'Clear an explicit block set by block_task, making the task eligible for auto-dispatch again (if its deps are satisfied). Idempotent — no-op if the task was not blocked.', inputSchema: { type: 'object', properties: { task_key: { type: 'string' } }, required: ['task_key'], additionalProperties: false }, run: (a, call) => call('POST', '/overlay/unblock', { key: a.task_key }) },
  // All agent-driven supersede ops should go through this tool — direct POST /supersede in scripts
  // is only for non-agent bootstrap paths (e.g. inject scripts that predate MCP).
  { name: 'supersede_task', description: 'Retire an old task in favor of a replacement, linking them, so a replan reconciles cleanly instead of leaving orphaned duplicates.', inputSchema: { type: 'object', properties: { old_task_key: { type: 'string' }, new_task_key: { type: 'string' }, reason: { type: 'string' } }, required: ['old_task_key', 'new_task_key'], additionalProperties: false }, run: (a, call) => call('POST', '/supersede', { old_key: a.old_task_key, new_key: a.new_task_key, reason: a.reason }) },
  { name: 'show_dashboard', description: 'Render the orchestrator task-graph dashboard INLINE in the conversation (interactive, live-updating). Use when the user wants to SEE the graph without a browser.', inputSchema: { type: 'object', properties: { workspace: { type: 'string', description: 'Optional workspace path to scope the dashboard view. When omitted the inline widget uses the daemon-global workspace.' } }, additionalProperties: false }, meta: { ui: { resourceUri: UI_URI, visibility: ['model', 'app'], csp: { connectDomains: [`http://localhost:${PORT}`, `http://127.0.0.1:${PORT}`, 'https://localhost:8788', 'https://127.0.0.1:8788'] } } }, run: (a) => {
      // The resourceUri is a fixed MCP protocol handle (ui://orchestrator/graph) — the MCP app
      // fetches it via resources/read, which serves public/inline.html. Parameterizing the URI
      // itself would require changes to both the MCP client's resource-fetch protocol and the
      // resources/read handler, which is out of scope and risks breaking existing consumers.
      // Instead, when the caller supplies a workspace, return a browser deep-link in the result
      // so the user or a consuming agent can navigate directly to the scoped view.
      const ws = (a && a.workspace) || null;
      if (ws) {
        const deepLink = `http://localhost:${PORT}/graph?workspace=${encodeURIComponent(ws)}`;
        return Promise.resolve({ rendered: true, workspace: ws, deep_link: deepLink, note: `Dashboard shown inline. To view only workspace '${ws}', open: ${deepLink}` });
      }
      return Promise.resolve({ rendered: true, note: 'Dashboard shown inline; it polls the daemon live.' });
    } },
];
const TOOL_BY_NAME = Object.fromEntries(TOOLS.map((t) => [t.name, t]));

function toolsForCtx(ctx) {
  const extra = ctx && ctx.extraTools;
  if (!extra || extra.length === 0) return TOOLS;
  return TOOLS.concat(extra);
}
function toolByNameForCtx(ctx) {
  const extra = ctx && ctx.extraTools;
  if (!extra || extra.length === 0) return TOOL_BY_NAME;
  return Object.fromEntries(toolsForCtx(ctx).map((t) => [t.name, t]));
}
function formatToolsList(tools) {
  return tools.map((t) => ({ name: t.name, description: t.description, inputSchema: t.inputSchema, ...(t.meta ? { _meta: t.meta } : {}) }));
}

// Advisory cooperative-stop (in-band counterpart to hooks/orch-stop.sh enforcement).
// When a tool call carries agent_id and that agent has stop_requested set (or, with session,
// /should-stop would halt the hook path), attach should_stop + reason to the MCP result WITHOUT
// blocking the call. Fail-open on daemon errors — same spirit as the hook's unreachable fallback.
async function stopAdvisory(agentId, call, session) {
  if (!agentId || typeof agentId !== 'string') return null;
  try {
    if (session) {
      const r = await call('GET', `/should-stop?${q({ session, agent: agentId })}`);
      if (r && r.stop) return { should_stop: true, reason: r.reason || 'stop_requested' };
      return null;
    }
    const r = await call('GET', `/agent/stop-requested?${q({ agent_id: agentId })}`);
    if (r && r.stop_requested) return { should_stop: true, reason: 'stop_requested' };
  } catch { /* fail open */ }
  return null;
}

function wrapToolResult(out, advisory) {
  const result = { content: [{ type: 'text', text: JSON.stringify(out, null, 2) }], isError: !!(out && out.error) };
  if (advisory) Object.assign(result, advisory);
  return result;
}

// Handle one JSON-RPC message. Returns the response object, or undefined for notifications.
async function handleRpc(msg, ctx) {
  const { id, method, params } = msg;
  const call = ctx.call, html = ctx.uiHtml || uiHtml;
  if (method === 'initialize') return { jsonrpc: '2.0', id, result: { protocolVersion: (params && params.protocolVersion) || DEFAULT_PROTOCOL, capabilities: { tools: {}, resources: {}, extensions: { 'io.modelcontextprotocol/ui': { mimeTypes: [UI_MIME] } } }, serverInfo: { name: 'orchestrator-graph', version: '0.1.0' } } };
  if (method === 'notifications/initialized' || method === 'initialized') return undefined;
  if (method === 'ping') return { jsonrpc: '2.0', id, result: {} };
  if (method === 'tools/list') return { jsonrpc: '2.0', id, result: { tools: formatToolsList(toolsForCtx(ctx)) } };
  if (method === 'resources/list') return { jsonrpc: '2.0', id, result: { resources: [{ uri: UI_URI, name: 'Orchestrator dashboard', mimeType: UI_MIME, description: 'Live task dependency graph (inline)' }] } };
  if (method === 'resources/read') {
    if (params && params.uri === UI_URI) return { jsonrpc: '2.0', id, result: { contents: [{ uri: UI_URI, mimeType: UI_MIME, text: html() }] } };
    return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown resource: ${params && params.uri}` } };
  }
  if (method === 'tools/call') {
    const name = params && params.name;
    const tool = toolByNameForCtx(ctx)[name];
    if (!tool) return { jsonrpc: '2.0', id, error: { code: -32602, message: `unknown tool: ${name}` } };
    // Usage beacon: tally every dispatch on the daemon. Covers BOTH transports at this single
    // choke point: `call` is always a daemon-bound HTTP client (makeCall), so counts from the
    // separate stdio process reach the daemon too; makeCall injects the session's workspace into
    // the POST body (the daemon falls back to its own). AWAITED (one loopback POST, never rejects)
    // so the short-lived stdio process can't exit before the beacon lands; never fails the call.
    const tally = (isError) => { try { return call('POST', '/analytics/tool-call', { tool: name, error: !!isError }); } catch { /* best effort */ } };
    let args = params.arguments || {};
    if (name === 'start_task' && !args.session_id && ctx.session) args = { ...args, session_id: ctx.session };
    if (name === 'request_guidance' && !args.session_id && ctx.session) args = { ...args, session_id: ctx.session };
    // Inject the session's workspace into show_dashboard so it can surface a scoped deep-link.
    // ctx.workspace is set by the stdio transport (WS from ORCH_WORKSPACE/cwd); when absent
    // (daemon's own /mcp handler) the tool falls back to daemon-global behavior.
    if (name === 'show_dashboard' && !args.workspace && ctx.workspace) args = { ...args, workspace: ctx.workspace };
    const agentId = args.agent_id || null;
    try {
      const out = await tool.run(args, call);
      await tally(out && out.error);
      const advisory = await stopAdvisory(agentId, call, ctx.session);
      return { jsonrpc: '2.0', id, result: wrapToolResult(out, advisory) };
    }
    catch (e) { await tally(true); return { jsonrpc: '2.0', id, result: { content: [{ type: 'text', text: `error: ${e.message}` }], isError: true } }; }
  }
  if (id != null) return { jsonrpc: '2.0', id, error: { code: -32601, message: `method not found: ${method}` } };
  return undefined;
}

module.exports = { UI_URI, UI_MIME, DEFAULT_PROTOCOL, TOOLS, toolsForCtx, formatToolsList, handleRpc, makeCall, uiHtml, readToken, stopAdvisory, wrapToolResult };
