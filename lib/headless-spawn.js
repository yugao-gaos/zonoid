'use strict';
/**
 * headless-spawn.js — daemon-internal executor for managed graph-loop SPAWN decisions.
 *
 * DESIGN
 * ------
 * Closes the full-autonomy gap: when a MANAGED graph loop (lib/loop-autostart.js — managed:'graph',
 * session:null) decides action:'spawn' and NO interactive session is driving, the daemon dispatches
 * the workers itself via headless LLM-backend children instead of waiting for a /next-action driver
 * that will never come. Real interactive drivers keep priority: the executor runs ONLY in the
 * zero-session regime and ONLY for workspaces that opted in (overlay config `headless_driver:true`,
 * default off).
 *
 * REUSED INFRASTRUCTURE (deliberately no second governor / spawn path)
 * --------------------------------------------------------------------
 *   - lib/headless-drain: the shared governor (_governor, effectiveConfig, backoff via
 *     recordDrainOutcome), the host-wide drain lease (_acquireGlobalDrainSlot), the async child
 *     spawner (runDrain — timeoutMs + SIGKILL bound), and _resolveMcpConfig (shared HTTP MCP).
 *   - lib/headless-drain-runner: the pump. daemon.js instantiates a SECOND runner over this
 *     executor's facade ({ runDueDrains, _governor }), so scheduling/backoff/wake behavior is
 *     identical to the drain pump with zero runner changes.
 *   - daemon decideAll: spawn decisions come from THE SAME decide pass /next-action serves.
 *     decideOne charges the loop (iterations++, estPerTick spend, headroom vs in_progress count)
 *     and acquires the 60s per-task spawn leases — so requirement "charge the loop like
 *     /next-action does" is satisfied by construction: it IS that path, not a reimplementation.
 *   - subconscious prepare: assignments are allocated through POST /subconscious/assignment
 *     (routes/subconscious.js), the same route the MCP `subconscious_assignment prepare` facade
 *     hits — same worktree allocation, same permit minting, same review-state recording.
 *
 * DOUBLE-DISPATCH SAFETY
 * ----------------------
 * The per-task spawn lease (overlay.spawnLease, 60s TTL, released on claim via
 * setStatus→clearSpawnLease) is the exclusivity primitive, exactly as for interactive drivers:
 * decideOne only returns tasks it could lease, and the executor re-verifies per task that the live
 * lease belongs to the deciding loop before dispatch (a foreign live lease ⇒ skip). A worker that
 * dies before claiming leaves the lease to expire (60s) — the task simply becomes spawnable again.
 *
 * WORKER FAILURE HANDLING
 * -----------------------
 * On child timeout/spawn-error/non-zero exit — or a clean exit that left the task in_progress
 * (worker exited without calling complete) — the executor posts the terminal failed status itself
 * (POST /overlay/status, task_result v1 status:'failed') so the task never strands in_progress
 * waiting for the staleness sweep. A task the worker never claimed (still ready) is left alone:
 * the spawn-lease TTL frees it for redispatch.
 *
 * WHY THE EXECUTOR SKIPS ENTIRELY WHILE ANY SESSION LOOP IS ACTIVE
 * ----------------------------------------------------------------
 * decideAll is a GLOBAL heartbeat: calling it leases every spawn decision it returns, including
 * session-bound loops' — consuming those here would stall the interactive driver's dispatch for a
 * lease TTL. And while an interactive session drives, its /next-action polling already serves the
 * managed loops too. So one active session-bound loop anywhere ⇒ the executor stands down.
 *
 * HEADLESS PLANNER (plan/optimize decisions)
 * ------------------------------------------
 * The same runDueSpawns pass ALSO executes a managed loop's drained-DAG 'plan' and 'optimize'
 * decisions by spawning a headless PLANNER child. This lives HERE (not a sibling module) because
 * decideAll must have exactly ONE headless consumer: decideOne charges the loop and mutates
 * per-loop state on every call, so a second independent consumer would double-tick loops and
 * double-lease spawn decisions. A loop's decision is exclusive per tick — it either spawns or
 * plans, never both — so worker and planner dispatch share one decide pass cleanly.
 *
 *   - Gates: same zero-session regime + headless_driver:true; 'plan' additionally requires
 *     ov.config.self_plan (decideOne only emits 'plan' under self_plan; re-checked here so a stale
 *     decision can never plan a workspace that opted out between decide and dispatch).
 *   - Debounce: at most ONE planner per workspace per drained-DAG event. A persisted overlay
 *     marker (overlay.planner = { lease, lastPlanAt, lastMode }) provides (a) a run lease so
 *     repeated pump ticks while a planner child runs don't stack planners, and (b) a cooldown
 *     after every finished run — a planner that proposed tasks naturally ends the drained state
 *     (next tick decides 'spawn'), so the cooldown only bites in the no-action case, which is
 *     exactly the required back-off (don't re-plan an unchanged drained graph every tick).
 *   - The child drives the brain-activation plan/optimize contract over the shared HTTP MCP
 *     config, with the hard guardrails (max 3 initiatives, dedup, wire everything, never touch
 *     in-flight tasks, request_guidance for high-impact ideas, no-action valid) IN THE PROMPT.
 *   - Governor: planner children ride the same shared headless-drain governor/slots as workers.
 *   - Backend: agentic-cli only. An api-kind backend is a clean 'no_backend' pause: the planner
 *     drives a multi-tool MCP skill (get_learnings/get_graph/TaskCreate/suggest_links/...), and
 *     the only api-provider loop that exists is runJudgeLoop — a judge-only single-verdict loop.
 *     A "lightweight api planner worker" would be a full agent loop, not a trivial worker, so it
 *     is deliberately skipped (same posture as resolveSpawnBackend for impl workers).
 */

const path = require('path');
const http = require('http');
const headlessDrain = require('./headless-drain');

// ---- constants -----------------------------------------------------------------------

const SELF_REPO = path.resolve(__dirname, '..');

// Stable drain key for dashboard/telemetry summaries (mirrors the drain-key naming convention).
const SPAWN_EXECUTOR_KEY = 'followup/harness-spawn-executor';

// Minted worker agent ids carry this prefix so claims/registrations are attributable.
const HEADLESS_WORKER_PREFIX = 'headless-worker-';

// Default daemon base URL for internal HTTP (prepare / terminal status) — same shape as
// headless-drain's DAEMON_BASE_URL (not exported there; the sibling drain task owns that file).
const DAEMON_BASE_URL = `http://localhost:${Number(process.env.ORCH_PORT) || 8787}`;

// Per-worker wall-clock timeout. Impl work runs far longer than a judge round (5min) — default
// 30min, overridable. runDrain enforces it with SIGKILL, so a hung worker cannot wedge a slot.
function workerTimeoutMs() {
  return Math.max(60_000, Number(process.env.HEADLESS_SPAWN_TIMEOUT_MS) || 30 * 60 * 1000);
}

// Stable drain key for planner runs (dashboard/telemetry summaries).
const PLANNER_DRAIN_KEY = 'followup/harness-planner-drain';

// Per-planner wall-clock timeout: planning is graph reads + a handful of node writes — far shorter
// than impl work. Default 15min, overridable; runDrain enforces it with SIGKILL.
function plannerTimeoutMs() {
  return Math.max(60_000, Number(process.env.HEADLESS_PLAN_TIMEOUT_MS) || 15 * 60 * 1000);
}

// Cooldown between planner runs per workspace. Only bites after a NO-ACTION run (a run that
// proposed tasks un-drains the DAG, so 'plan' stops firing on its own). Overlay config wins, then
// env, then 30min. `>= 0` checks let tests/config disable the cooldown with an explicit 0.
function plannerCooldownMs(overlay) {
  const cfgRaw = overlay && overlay.config ? overlay.config.planner_cooldown_ms : null;
  const cfgV = cfgRaw == null ? NaN : Number(cfgRaw);
  if (Number.isFinite(cfgV) && cfgV >= 0) return cfgV;
  const envV = Number(process.env.HEADLESS_PLAN_COOLDOWN_MS);
  if (Number.isFinite(envV) && envV >= 0) return envV;
  return 30 * 60 * 1000;
}

// ---- config gate ---------------------------------------------------------------------

// Executor opt-in is per workspace: overlay config `headless_driver:true` (default OFF). Session-
// bound loops are never served here regardless of this flag — they belong to their driver.
function headlessDriverEnabled(overlay) {
  const v = overlay && overlay.config && overlay.config.headless_driver;
  return v === true || v === 1 || v === '1' || v === 'true';
}

// Second gate for 'plan' decisions only: overlay config `self_plan:true` (default OFF — same
// posture as decideOne, which only emits 'plan' under this flag). 'optimize' decisions are NOT
// gated on self_plan, matching daemon.js where applyOptimize runs before the self_plan check.
function selfPlanEnabled(overlay) {
  const v = overlay && overlay.config && overlay.config.self_plan;
  return v === true || v === 1 || v === '1' || v === 'true';
}

// ---- planner debounce state (overlay.planner — persisted via the overlay LOCAL_FIELDS) ------
// Mirrors the spawn/review lease pattern, but per WORKSPACE (one planner slot), not per task:
//   overlay.planner = { lease: { leaseExpiry, owner, mode }, lastPlanAt: ms, lastMode }
// The lease covers a running child (repeated ticks skip); lastPlanAt drives the cooldown.

function _plannerState(overlay) {
  if (!overlay.planner || typeof overlay.planner !== 'object') overlay.planner = {};
  return overlay.planner;
}

function hasLivePlannerLease(overlay, nowMs = Date.now()) {
  const p = overlay && overlay.planner;
  return !!(p && p.lease && p.lease.leaseExpiry > nowMs);
}

function acquirePlannerLease(overlay, owner, ttlMs, mode) {
  if (!overlay) return false;
  const p = _plannerState(overlay);
  if (p.lease && p.lease.leaseExpiry > Date.now()) return false;
  p.lease = { leaseExpiry: Date.now() + (ttlMs || 60000), owner: owner || null, mode: mode || 'plan' };
  return true;
}

function plannerOnCooldown(overlay, nowMs = Date.now()) {
  const p = overlay && overlay.planner;
  return !!(p && p.lastPlanAt && nowMs < p.lastPlanAt + plannerCooldownMs(overlay));
}

// Stamp a finished planner run: clears the run lease and starts the cooldown window. Called after
// EVERY actual child run (clean or not) — a failing planner must not hot-loop either, and a run
// that proposed tasks makes the cooldown moot (the DAG is no longer drained).
function markPlannerRan(overlay, mode) {
  if (!overlay) return;
  const p = _plannerState(overlay);
  delete p.lease;
  p.lastPlanAt = Date.now();
  p.lastMode = mode || 'plan';
}

// ---- internal daemon HTTP ------------------------------------------------------------
// Small local POST helper (mirrors headless-drain's postDaemonJson, which is not exported — the
// parallel review-drain task owns that file, so we keep our edits there at zero).

function daemonToken() {
  try { return require('./mcp-core').readToken(); } catch { return null; }
}

function postDaemonJson(route, body, httpModule = http) {
  return new Promise((resolve) => {
    let u;
    try { u = new URL(route, DAEMON_BASE_URL); } catch (err) {
      resolve({ ok: false, error: err && err.message ? err.message : String(err) });
      return;
    }
    const payload = JSON.stringify(body || {});
    const headers = {
      'content-type': 'application/json',
      'content-length': Buffer.byteLength(payload),
    };
    const token = daemonToken();
    if (token) headers['x-orch-token'] = token;
    const req = httpModule.request({
      protocol: u.protocol,
      hostname: u.hostname,
      port: u.port,
      path: `${u.pathname}${u.search}`,
      method: 'POST',
      headers,
    }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { text += chunk; });
      res.on('end', () => {
        let parsed = {};
        try { parsed = text ? JSON.parse(text) : {}; } catch { parsed = { raw: text }; }
        if (res.statusCode >= 400) parsed = { ...parsed, ok: false, status: res.statusCode, error: parsed.error || `HTTP ${res.statusCode}` };
        resolve(parsed);
      });
    });
    req.on('error', (err) => resolve({ ok: false, error: err && err.message ? err.message : String(err) }));
    req.end(payload);
  });
}

// ---- worker identity / envelope / prompt ----------------------------------------------

// Deterministic per-task worker id: reused on accept, complete, AND the executor's own failure
// write, so the terminal failed post matches the claim owner.
function workerAgentId(taskKey) {
  return `${HEADLESS_WORKER_PREFIX}${String(taskKey || '').replace(/[^A-Za-z0-9._-]+/g, '-')}`;
}

/**
 * Build the typed handoff_envelope (schemas/handoff.v1.schema.json) from the prepare response.
 * Slotted fields are copied from the daemon-allocated assignment — the worker copies them verbatim
 * into its graph calls instead of re-deriving them from prose. context_deps are the pre-resolved
 * Tier-1 dependency summaries the prepare route already assembled (dispatcher duty, not worker's).
 */
function buildHandoffEnvelope({ job, prepare, agentId, siblings }) {
  const a = (prepare && prepare.assignment) || {};
  const pdc = a.progressive_disclosure_context;
  const summaries = (a.context && Array.isArray(a.context.dependency_summaries)) ? a.context.dependency_summaries : [];
  return {
    version: 1,
    task_key: job.key,
    agent_id: agentId,
    branch: prepare.branch || a.branch,
    target_repo: prepare.target_repo || a.target_repo,
    worktree: prepare.worktree || a.worktree,
    base: a.base || null,
    files_in_scope: [],
    plan_goal: (pdc && pdc.layer1 && pdc.layer1.why) || job.label || job.key,
    sibling_tasks: (siblings || []).map((s) => ({ task_key: s.key, title: s.label || s.key })),
    context_deps: summaries
      .filter((d) => d && d.summary)
      .map((d) => ({ task_key: d.key || d.task_key || null, summary: d.summary })),
    return_contract: "task_result v1: {version:1, status:'tested'|'failed', summary, files_changed[], tests_run, decisions[]}",
  };
}

/**
 * The worker contract prompt: accept → implement in the worktree → commit → complete with a
 * task_result v1 (failed on any unrecoverable error). Same duties as an Agent-tool dispatched
 * worker; the envelope carries the slots. The child's cwd is the attempt worktree, and the
 * orchestrator-graph MCP is granted via the shared HTTP mcp-config (_resolveMcpConfig).
 */
function buildWorkerPrompt(envelope) {
  return [
    `You are an orchestrator worker dispatched headlessly by the daemon. Implement graph task ${envelope.task_key}` +
      ` ("${envelope.plan_goal}") in the attempt worktree you are running in.`,
    '',
    'HANDOFF ENVELOPE (copy these slots verbatim into your graph calls — do not re-derive):',
    JSON.stringify(envelope, null, 2),
    '',
    'MANDATORY WORKER PROTOCOL:',
    `1. FIRST call the orchestrator-graph MCP tool subconscious_assignment {action:"accept", task_key:${JSON.stringify(envelope.task_key)}, agent_id:${JSON.stringify(envelope.agent_id)}, session_id:${JSON.stringify(envelope.agent_id)}} BEFORE any file write. If it errors or returns 409, STOP — do not force or work around the gate.`,
    `2. ALL file edits happen inside your cwd (the attempt worktree, branch ${envelope.branch}). Never edit any other checkout.`,
    '3. Before completing: run `git add -A && git commit` in the worktree — uncommitted work makes the later merge a silent no-op.',
    `4. Finish with subconscious_assignment {action:"complete", task_key:${JSON.stringify(envelope.task_key)}, agent_id:${JSON.stringify(envelope.agent_id)}, status:"tested"|"failed", task_result:{version:1, status, summary:"<tight interface summary>", files_changed:[...], tests_run:"<cmd + outcome>", decisions:[]}}. On ANY unrecoverable error still call complete with status:"failed" — never exit silently.`,
    `5. If you record a durable decision via record_decision, pass wires_to:[${JSON.stringify(envelope.task_key)}].`,
  ].join('\n');
}

/**
 * Build the planner-child prompt (the -p text) for a drained-DAG 'plan' or 'optimize' decision.
 * The child drives the brain-activation plan/optimize contract through the orchestrator-graph MCP
 * tools ONLY (never raw daemon HTTP — several daemon routes ignore a body `workspace` field, so
 * MCP, which pins the workspace, is the safe transport). The hard guardrails live IN THE PROMPT:
 * a planner child has no gate hook, so the prompt is the enforcement surface. Pure.
 *
 * @param {object} opts — { mode:'plan'|'optimize', workspace, decision } where decision carries
 *                        the decideOne payload (optimize: { problem, label, metric, prior_verdict }).
 */
function buildPlannerPrompt(opts = {}) {
  const mode = opts.mode === 'optimize' ? 'optimize' : 'plan';
  const workspace = String(opts.workspace || '');
  const d = opts.decision || {};

  const lines = [
    `You are the daemon's headless PLANNER for workspace ${workspace}. The task DAG is drained; run the brain-activation ${mode}-mode contract ONCE, then stop.`,
    'Operate ONLY via the orchestrator-graph MCP tools — never shell to the daemon or call its HTTP routes directly.',
    '',
  ];

  if (mode === 'optimize') {
    const winner = d.prior_verdict && d.prior_verdict.winner != null ? String(d.prior_verdict.winner) : null;
    lines.push(
      `OPTIMIZE MODE: problem task ${d.problem} ("${d.label || d.problem}") is iterating on metric ${d.metric}.`,
      `Prior verdict (JSON): ${JSON.stringify(d.prior_verdict || null)}`,
      `Propose a DIFFERENT change than the prior winner${winner ? ` (${winner})` : ''} — never re-propose the approach that already won or lost this round.`,
      `Only ADD a fresh attempts->judge round on the SAME problem task ${d.problem}: new attempt tasks (rival approaches) wired to ${d.problem}, and a judge task blocked_by each attempt. Do NOT create unrelated initiatives, and NEVER cancel or edit the existing problem/attempt nodes.`,
      ''
    );
  }

  lines.push(
    'PROCEDURE: call get_learnings() and get_graph() FIRST. Build the open set (in_progress/ready/not_ready — the no-fly zone), the done/note anchors, and the rejected-approaches ledger from get_learnings().rejected[].',
    '',
    'HARD GUARDRAILS:',
    '1. Propose AT MOST 3 new initiatives — fewer is better; graph bloat is failure.',
    '2. Dedup BEFORE creating: if a candidate overlaps an open task, DROP it; if it re-proposes an entry from the rejected-approaches ledger, DROP it or pivot to a genuinely different approach.',
    '3. WIRE every new task: run suggest_links(new_key) and add add_dependency context/blocking edges from its matches. Never leave a new task as an orphan root — if suggest_links returns nothing, hand-wire at least one context edge to the most related done/note node.',
    '4. NEVER cancel, supersede, or modify any in-flight task (in_progress/ready/not_ready). You only ADD nodes.',
    '5. Route irreversible, outward-facing, high-impact, or scope-expanding proposals through request_guidance instead of silently creating them — the ask-gate decides whether to predict or escalate.',
    '6. NO-ACTION IS A VALID OUTCOME: if nothing is genuinely worth doing, create nothing and report "no action — graph is in a good state". Do not fabricate work to look busy.',
    '',
    'Run once, report what you proposed (or no-action) and how each new node was wired, then stop — do not loop, re-plan, or spawn workers.'
  );

  return { prompt: lines.join('\n'), mode };
}

// ---- backend resolution ----------------------------------------------------------------
// Same shape as headless-drain's resolveJudgeBackend, but for IMPL workers: only agentic-cli
// providers can run one (api providers expose runJudgeLoop — a judge-only loop; there is no API
// code-worker yet), so an api backend HARD-BLOCKS with the same clean 'no_backend' pause as an
// unusable/unauthed CLI. No invocation is built here — the prompt is per-task.

function safeBool(fn) { try { return !!fn(); } catch { return false; } }

function resolveSpawnBackend(overlay, deps = {}) {
  const backendLib = deps.backendLib || require('./llm-backend');
  const active = backendLib.getActiveBackend(overlay);
  const provider = active && active.provider;
  if (!provider) return { skip: 'no_backend' };
  if (provider.kind !== 'agentic-cli') return { skip: 'no_backend' };
  const available = typeof provider.isAvailable === 'function' ? safeBool(provider.isAvailable.bind(provider)) : false;
  const authed = typeof provider.isAuthed === 'function' ? safeBool(provider.isAuthed.bind(provider)) : false;
  if (!available || !authed) return { skip: 'no_backend' };
  return { provider, providerId: active.providerId, model: active.model };
}

// ---- defaults for injectable seams ------------------------------------------------------

function defaultPrepareAssignment({ workspace, task_key, agent_id }, httpModule) {
  // Same-node review is requested by default (judge_requested:true, create_judge:false): the
  // headless review-verdict drain owns approving/merging these attempts, closing the loop without
  // an interactive dispatcher. The prepare route allocates orch/attempt/<key> + the envelope.
  return postDaemonJson('/subconscious/assignment', {
    action: 'prepare',
    workspace,
    task_key,
    agent_id,
    create_judge: false,
    judge_requested: true,
  }, httpModule);
}

function defaultCompleteFailed({ workspace, key, agent_id, reason }, httpModule) {
  return postDaemonJson('/overlay/status', {
    workspace,
    key,
    status: 'failed',
    agent_id,
    note: 'headless spawn executor: worker child did not complete',
    summary: reason,
    task_result: {
      version: 1,
      status: 'failed',
      summary: reason,
      files_changed: [],
      tests_run: 'none — headless worker child did not complete',
      decisions: [],
    },
  }, httpModule);
}

// ---- one worker dispatch ----------------------------------------------------------------

/**
 * Dispatch ONE prepared worker child and settle its outcome. Owns the governor slot handed to it
 * (decrements concurrentRunning + releases the host-wide lease in finally). Pushes a summary onto
 * `drains`. Never throws — every failure path resolves to a summary + (when needed) a terminal
 * failed write so the task cannot strand in_progress.
 */
async function _runOneWorker({ job, siblings, provider, model, deps, governor, slot, drains }) {
  const agentId = workerAgentId(job.key);
  const timeoutMs = workerTimeoutMs();
  const runDrain = deps.runDrain || headlessDrain.runDrain;
  const recordOutcome = deps.recordOutcome || headlessDrain.recordDrainOutcome;
  const summary = { drain: SPAWN_EXECUTOR_KEY, task: job.key, workspace: job.ws, agent_id: agentId };

  let released = false;
  const releaseSlot = () => {
    if (released) return;
    released = true;
    governor.concurrentRunning = Math.max(0, governor.concurrentRunning - 1);
    if (slot && typeof slot.release === 'function') slot.release();
  };

  try {
    // 1. Prepare the assignment (attempt worktree orch/attempt/<key> + envelope) through the same
    //    route the MCP prepare facade uses — same worktree allocation and permit minting.
    let prepare;
    try {
      prepare = await (deps.prepareAssignment || defaultPrepareAssignment)(
        { workspace: job.ws, task_key: job.key, agent_id: agentId }, deps.httpModule
      );
    } catch (e) {
      prepare = { ok: false, error: e && e.message ? e.message : String(e) };
    }
    if (!prepare || prepare.ok === false || !(prepare.worktree || (prepare.assignment && prepare.assignment.worktree))) {
      summary.skipped = 'prepare_failed';
      summary.error = (prepare && prepare.error) || 'prepare returned no worktree';
      drains.push(summary);
      process.stdout.write(`[headless-spawn] PREPARE FAILED task=${job.key} error=${summary.error}\n`);
      return;
    }
    const worktree = prepare.worktree || prepare.assignment.worktree;

    // 2. Build the typed envelope + worker-contract prompt, then the provider-owned invocation.
    const envelope = buildHandoffEnvelope({ job, prepare, agentId, siblings });
    const prompt = buildWorkerPrompt(envelope);
    const mcpConfig = (deps.resolveMcpConfig || headlessDrain._resolveMcpConfig)(job.ws);
    let invocation;
    try {
      invocation = provider.buildInvocation({
        prompt,
        model,
        mcpConfig: mcpConfig || undefined,
        addDir: [envelope.target_repo, worktree].filter(Boolean),
      });
    } catch (e) {
      summary.skipped = 'invocation_failed';
      summary.error = e && e.message ? e.message : String(e);
      drains.push(summary);
      return;
    }

    process.stdout.write(`[headless-spawn] WORKER starting task=${job.key} provider=${provider.id} worktree=${worktree}\n`);

    // 3. Spawn the child through the shared runDrain (timeoutMs + SIGKILL bound). cwd = the attempt
    //    worktree so the worker's file writes land on the right branch by construction.
    const env = invocation.env ? { ...process.env, ...invocation.env } : undefined;
    let result;
    try {
      result = await runDrain({ bin: invocation.bin, args: invocation.args, env, cwd: worktree, timeoutMs });
    } finally {
      releaseSlot();
    }

    const clean = result.exitCode === 0 && !result.timedOut && !result.spawnError;
    if (clean) {
      // Clean run resets the shared LLM backoff (same semantics as a clean judge round; done here
      // directly because recordDrainOutcome only resets for its own drain kinds).
      governor.consecutiveThrottles = 0;
      governor.backoffUntil = 0;
    } else {
      recordOutcome(result); // throttle/timeout/failure feeds the shared rate-limit backoff
    }

    summary.exitCode = result.exitCode;
    summary.timedOut = result.timedOut;
    summary.spawnError = result.spawnError;

    // 4. Strand guard: whatever the exit looked like, the task's status decides the cleanup.
    //    in_progress ⇒ the worker claimed but never completed — post the terminal failed status
    //    (primary path; the staleness sweep is last resort). Still ready/pending ⇒ never claimed —
    //    the 60s spawn-lease TTL frees it for redispatch, nothing to write.
    const after = _safeOverlayLoad(job.ws, deps);
    const status = after && after.status ? after.status[job.key] : undefined;
    if (status === 'in_progress') {
      const reason = result.timedOut
        ? `Headless worker timed out after ${timeoutMs}ms without completing the assignment.`
        : `Headless worker exited (code ${result.exitCode}${result.spawnError ? `, spawn error: ${result.spawnError}` : ''}) without completing the assignment.`;
      const failed = await (deps.completeFailed || defaultCompleteFailed)(
        { workspace: job.ws, key: job.key, agent_id: agentId, reason }, deps.httpModule
      );
      summary.marked_failed = !(failed && failed.error);
      if (failed && failed.error) summary.error = failed.error;
    } else if (!clean && (status === undefined || status === 'ready' || status === 'pending')) {
      summary.never_claimed = true;
    }

    drains.push(summary);
    process.stdout.write(
      `[headless-spawn] WORKER ${clean ? 'done' : 'FAILED'} task=${job.key} exit=${result.exitCode} timedOut=${result.timedOut}` +
      `${summary.marked_failed ? ' marked_failed=true' : ''}\n`
    );
  } catch (e) {
    releaseSlot();
    summary.skipped = 'error';
    summary.error = e && e.message ? e.message : String(e);
    drains.push(summary);
  } finally {
    releaseSlot();
  }
}

/**
 * Dispatch ONE planner child for a drained-DAG plan/optimize decision and settle its outcome.
 * Owns the governor slot handed to it (mirrors _runOneWorker's release discipline). After ANY
 * actual child run the workspace's planner marker is stamped (lease cleared + cooldown started)
 * on a FRESH overlay read — the child mutates the overlay (TaskCreate/notes) while it runs, so
 * writing back the pre-spawn snapshot would clobber its work. Never throws.
 */
async function _runOnePlanner({ job, provider, model, deps, governor, slot, drains }) {
  const timeoutMs = plannerTimeoutMs();
  const runDrain = deps.runDrain || headlessDrain.runDrain;
  const recordOutcome = deps.recordOutcome || headlessDrain.recordDrainOutcome;
  const summary = { drain: PLANNER_DRAIN_KEY, workspace: job.ws, mode: job.mode };
  if (job.problem) summary.problem = job.problem;

  let released = false;
  const releaseSlot = () => {
    if (released) return;
    released = true;
    governor.concurrentRunning = Math.max(0, governor.concurrentRunning - 1);
    if (slot && typeof slot.release === 'function') slot.release();
  };

  try {
    const { prompt } = buildPlannerPrompt({ mode: job.mode, workspace: job.ws, decision: job.decision });
    const mcpConfig = (deps.resolveMcpConfig || headlessDrain._resolveMcpConfig)(job.ws);
    let invocation;
    try {
      invocation = provider.buildInvocation({
        prompt,
        model,
        mcpConfig: mcpConfig || undefined,
        addDir: [job.ws],
      });
    } catch (e) {
      // No child ran ⇒ no cooldown stamp; the run lease simply expires (TTL) before a retry.
      summary.skipped = 'invocation_failed';
      summary.error = e && e.message ? e.message : String(e);
      drains.push(summary);
      return;
    }

    process.stdout.write(`[headless-plan] PLANNER starting ws=${job.ws} mode=${job.mode} provider=${provider.id}\n`);

    // cwd = the workspace root: the planner only writes graph nodes (via MCP), never files, so it
    // needs no attempt worktree — same working directory an interactive planning session would use.
    const env = invocation.env ? { ...process.env, ...invocation.env } : undefined;
    let result;
    try {
      result = await runDrain({ bin: invocation.bin, args: invocation.args, env, cwd: job.ws, timeoutMs });
    } finally {
      releaseSlot();
    }

    const clean = result.exitCode === 0 && !result.timedOut && !result.spawnError;
    if (clean) {
      governor.consecutiveThrottles = 0;
      governor.backoffUntil = 0;
    } else {
      recordOutcome(result); // throttle/timeout/failure feeds the shared rate-limit backoff
    }

    // Debounce stamp on a FRESH overlay (the child changed the graph/overlay while running):
    // clear the run lease, start the cooldown. Applies to unclean runs too — a crashing planner
    // must not hot-loop any more than a no-action one.
    const after = _safeOverlayLoad(job.ws, deps);
    if (after) {
      markPlannerRan(after, job.mode);
      const overlayStore = deps.overlayStore || require('./overlay');
      const overlaySave = deps.overlaySave || overlayStore.save;
      try { overlaySave(job.ws, after); } catch { /* marker is best-effort persisted; lease TTL bounds harm */ }
    }

    summary.exitCode = result.exitCode;
    summary.timedOut = result.timedOut;
    summary.spawnError = result.spawnError;
    drains.push(summary);
    process.stdout.write(
      `[headless-plan] PLANNER ${clean ? 'done' : 'FAILED'} ws=${job.ws} mode=${job.mode} exit=${result.exitCode} timedOut=${result.timedOut}\n`
    );
  } catch (e) {
    releaseSlot();
    summary.skipped = 'error';
    summary.error = e && e.message ? e.message : String(e);
    drains.push(summary);
  } finally {
    releaseSlot();
  }
}

function _safeOverlayLoad(workspaceRoot, deps = {}) {
  try {
    const overlayLoad = deps.overlayLoad || require('./overlay').load;
    return overlayLoad(workspaceRoot) || null;
  } catch {
    return null;
  }
}

// ---- pump entry point --------------------------------------------------------------------

/**
 * Check gates + governor and dispatch headless workers for any due managed-loop spawn decisions,
 * plus headless PLANNER children for drained-DAG plan/optimize decisions (see module header).
 * Facade-compatible with headless-drain's runDueDrains ({ ran, skipped, drains }), so it plugs
 * straight into createHeadlessDrainRunner as a second runner instance.
 *
 * @param {object} state — daemon state (unused beyond parity with runDueDrains; loops carry their
 *                         own workspace pins).
 * @param {object} deps — injection seams (all optional in production, used by tests):
 *   loops            — the daemon's loop registry Map (REQUIRED; supplied by createSpawnExecutor).
 *   decide           — () => decideAll() decisions (REQUIRED; supplied by createSpawnExecutor).
 *   overlayLoad/overlaySave, prepareAssignment, completeFailed, backendLib, runDrain,
 *   acquireSlot, governor, resolveMcpConfig, recordOutcome, effectiveConfig, httpModule.
 */
async function runDueSpawns(state, deps = {}) {
  const governor = deps.governor || headlessDrain._governor;
  const cfg = (deps.effectiveConfig || headlessDrain.effectiveConfig)();
  const loops = deps.loops;
  if (!loops || typeof deps.decide !== 'function') {
    return { ran: 0, skipped: 'not_wired', drains: [] };
  }

  // ---- shared-governor budget/backoff checks (identical semantics to runDueDrains) --------
  if (Date.now() < governor.backoffUntil) return { ran: 0, skipped: 'backoff', drains: [] };
  if (governor.iterationsUsed >= cfg.maxIterations) return { ran: 0, skipped: 'iterations_exhausted', drains: [] };
  if (governor.tokensUsed >= cfg.tokenBudget) return { ran: 0, skipped: 'token_budget_exhausted', drains: [] };
  if (governor.concurrentRunning >= cfg.maxConcurrency) return { ran: 0, skipped: 'concurrency_cap', drains: [] };

  // ---- eligibility gates (all BEFORE the decide pass, so a gated-off daemon never ticks loops
  //      or leases tasks from here) ---------------------------------------------------------
  const allLoops = [...loops.values()];
  // Requirement: never serve session-bound loops, and stand down entirely while any interactive
  // driver is live (see module header — decideAll is global; consuming it here would steal the
  // driver's spawn decisions for a lease TTL).
  if (allLoops.some((L) => L && L.active && L.session)) {
    return { ran: 0, skipped: 'interactive_driver_active', drains: [] };
  }
  const managed = allLoops.filter((L) => L && L.active && L.managed === 'graph' && !L.session && L.workspace);
  if (!managed.length) return { ran: 0, skipped: 'no_managed_loops', drains: [] };

  // Config gate: per-workspace opt-in (overlay config headless_driver:true, default OFF).
  const gatedWs = new Set();
  for (const L of managed) {
    if (gatedWs.has(L.workspace)) continue;
    const ov = _safeOverlayLoad(L.workspace, deps);
    if (headlessDriverEnabled(ov)) gatedWs.add(L.workspace);
  }
  if (!gatedWs.size) return { ran: 0, skipped: 'headless_driver_off', drains: [] };

  // ---- decide pass: THE SAME decideAll /next-action drivers call. decideOne charges each loop
  //      (iterations, estPerTick spend, in_progress headroom) and leases the picked tasks. -----
  let decisions;
  try {
    decisions = deps.decide() || [];
  } catch (e) {
    return { ran: 0, skipped: 'decide_failed', error: e && e.message ? e.message : String(e), drains: [] };
  }

  // Collect spawn jobs from MANAGED loops of gated-on workspaces only. Session-bound or foreign-
  // workspace decisions are never executed here (their tasks' leases simply expire in 60s — and in
  // the zero-session regime nobody else was going to dispatch them anyway).
  const jobs = [];
  const planJobs = [];
  for (const d of decisions) {
    const L = d ? loops.get(d.loopId) : null;
    if (!L || L.managed !== 'graph' || L.session || !gatedWs.has(L.workspace)) continue;
    if (d.action === 'spawn' && Array.isArray(d.tasks)) {
      for (const t of d.tasks) {
        if (t && t.key) jobs.push({ ws: L.workspace, loopId: d.loopId, key: t.key, label: t.label });
      }
    } else if (d.action === 'plan' || d.action === 'optimize') {
      // Drained-DAG planner decision (one per loop per tick — decideOne emits it INSTEAD of
      // spawn). The full decideOne payload rides along: optimize carries problem/metric/
      // prior_verdict, which the planner prompt must embed.
      planJobs.push({ ws: L.workspace, loopId: d.loopId, mode: d.action, problem: d.problem || null, decision: d });
    }
  }
  if (!jobs.length && !planJobs.length) return { ran: 0, skipped: 'no_spawn_decisions', drains: [] };

  const drains = [];
  let skipReason = null;
  const acquireSlot = deps.acquireSlot || headlessDrain._acquireGlobalDrainSlot;
  const overlayByWs = new Map();           // one post-decide overlay read per workspace this pump
  const backendByWs = new Map();           // one backend resolve per workspace this pump
  const active = new Set();
  let dispatched = 0;

  for (const job of jobs) {
    // Lease verification (double-dispatch guard, same primitive as interactive drivers): the live
    // spawn lease must belong to the loop whose decision we are executing. A foreign live lease
    // means another dispatcher owns this task right now — skip it. A missing/expired lease (e.g.
    // it lapsed between decide and dispatch) is re-acquired under the same loop id before spawn.
    let ov = overlayByWs.get(job.ws);
    if (!ov) {
      ov = _safeOverlayLoad(job.ws, deps);
      overlayByWs.set(job.ws, ov);
    }
    const overlayStore = deps.overlayStore || require('./overlay');
    const lease = ov && ov.spawnLease && ov.spawnLease[job.key];
    const live = !!(lease && lease.leaseExpiry > Date.now());
    if (live && lease.loopId !== job.loopId) {
      drains.push({ drain: SPAWN_EXECUTOR_KEY, task: job.key, workspace: job.ws, skipped: 'lease_held' });
      skipReason = skipReason || 'lease_held';
      continue;
    }
    if (!live && ov) {
      if (!overlayStore.acquireSpawnLease(ov, job.key, job.loopId, 60000)) {
        drains.push({ drain: SPAWN_EXECUTOR_KEY, task: job.key, workspace: job.ws, skipped: 'lease_held' });
        skipReason = skipReason || 'lease_held';
        continue;
      }
      const overlaySave = deps.overlaySave || overlayStore.save;
      try { overlaySave(job.ws, ov); } catch { /* lease is best-effort persisted; TTL bounds harm */ }
    }

    // Backend (once per workspace): agentic-cli only; a HARD-BLOCK is a clean pause, not a crash.
    let backend = backendByWs.get(job.ws);
    if (!backend) {
      backend = resolveSpawnBackend(ov || {}, deps);
      backendByWs.set(job.ws, backend);
    }
    if (backend.skip) {
      drains.push({ drain: SPAWN_EXECUTOR_KEY, task: job.key, workspace: job.ws, skipped: backend.skip });
      skipReason = skipReason || backend.skip;
      continue;
    }

    // Governor slot (shared with the drain pool — one concurrency/budget surface for ALL headless
    // children). The host-wide lease uses the WORKER timeout for its expiry, not the drain default.
    if (governor.concurrentRunning >= cfg.maxConcurrency || governor.iterationsUsed >= cfg.maxIterations) {
      drains.push({ drain: SPAWN_EXECUTOR_KEY, task: job.key, workspace: job.ws, skipped: 'concurrency_cap' });
      skipReason = skipReason || 'concurrency_cap';
      continue;
    }
    const slot = acquireSlot({ ...cfg, timeoutMs: workerTimeoutMs() }, 'spawn-exec');
    if (!slot.ok) {
      drains.push({ drain: SPAWN_EXECUTOR_KEY, task: job.key, workspace: job.ws, skipped: slot.reason });
      skipReason = skipReason || slot.reason;
      continue;
    }
    governor.concurrentRunning++;
    governor.iterationsUsed++;
    dispatched++;

    const siblings = jobs.filter((j) => j !== job && j.ws === job.ws);
    let run;
    run = _runOneWorker({ job, siblings, provider: backend.provider, model: backend.model, deps, governor, slot, drains })
      .finally(() => { active.delete(run); });
    active.add(run);
  }

  // ---- planner dispatch (drained-DAG plan/optimize decisions) -----------------------------
  // At most ONE planner per workspace per pump; the persisted lease + cooldown debounce across
  // pumps. Reuses the same per-workspace overlay/backend caches and governor slots as workers.
  const plannedWs = new Set();
  for (const job of planJobs) {
    if (plannedWs.has(job.ws)) continue;
    plannedWs.add(job.ws);
    let ov = overlayByWs.get(job.ws);
    if (!ov) {
      ov = _safeOverlayLoad(job.ws, deps);
      overlayByWs.set(job.ws, ov);
    }

    // 'plan' re-checks self_plan (decideOne already gates it; a stale decision must never plan a
    // workspace that opted out between decide and dispatch). 'optimize' needs no self_plan.
    if (job.mode === 'plan' && !selfPlanEnabled(ov)) {
      drains.push({ drain: PLANNER_DRAIN_KEY, workspace: job.ws, mode: job.mode, skipped: 'self_plan_off' });
      skipReason = skipReason || 'self_plan_off';
      continue;
    }

    // Debounce: a live lease means a planner child is (or very recently was) running for this
    // workspace; the cooldown means the last run finished without un-draining the DAG (no-action).
    if (hasLivePlannerLease(ov)) {
      drains.push({ drain: PLANNER_DRAIN_KEY, workspace: job.ws, mode: job.mode, skipped: 'planner_running' });
      skipReason = skipReason || 'planner_running';
      continue;
    }
    if (plannerOnCooldown(ov)) {
      drains.push({ drain: PLANNER_DRAIN_KEY, workspace: job.ws, mode: job.mode, skipped: 'planner_cooldown' });
      skipReason = skipReason || 'planner_cooldown';
      continue;
    }

    // Backend (shared per-workspace cache): agentic-cli only — see module header for why an
    // api-kind backend is a clean no_backend pause rather than a lightweight api planner worker.
    let backend = backendByWs.get(job.ws);
    if (!backend) {
      backend = resolveSpawnBackend(ov || {}, deps);
      backendByWs.set(job.ws, backend);
    }
    if (backend.skip) {
      drains.push({ drain: PLANNER_DRAIN_KEY, workspace: job.ws, mode: job.mode, skipped: backend.skip });
      skipReason = skipReason || backend.skip;
      continue;
    }

    // Governor slot — same shared surface as workers; the host-wide lease uses the PLANNER timeout.
    if (governor.concurrentRunning >= cfg.maxConcurrency || governor.iterationsUsed >= cfg.maxIterations) {
      drains.push({ drain: PLANNER_DRAIN_KEY, workspace: job.ws, mode: job.mode, skipped: 'concurrency_cap' });
      skipReason = skipReason || 'concurrency_cap';
      continue;
    }
    const slot = acquireSlot({ ...cfg, timeoutMs: plannerTimeoutMs() }, 'plan-exec');
    if (!slot.ok) {
      drains.push({ drain: PLANNER_DRAIN_KEY, workspace: job.ws, mode: job.mode, skipped: slot.reason });
      skipReason = skipReason || slot.reason;
      continue;
    }

    // Lease BEFORE spawn (persisted) so repeated pump ticks while the child runs don't stack
    // planners. TTL = child timeout + margin; _runOnePlanner clears it when the run settles.
    if (!acquirePlannerLease(ov, `headless-plan:${process.pid}`, plannerTimeoutMs() + 60_000, job.mode)) {
      if (typeof slot.release === 'function') slot.release();
      drains.push({ drain: PLANNER_DRAIN_KEY, workspace: job.ws, mode: job.mode, skipped: 'planner_running' });
      skipReason = skipReason || 'planner_running';
      continue;
    }
    {
      const overlayStore = deps.overlayStore || require('./overlay');
      const overlaySave = deps.overlaySave || overlayStore.save;
      try { overlaySave(job.ws, ov); } catch { /* lease is best-effort persisted; TTL bounds harm */ }
    }
    governor.concurrentRunning++;
    governor.iterationsUsed++;
    dispatched++;

    let run;
    run = _runOnePlanner({ job, provider: backend.provider, model: backend.model, deps, governor, slot, drains })
      .finally(() => { active.delete(run); });
    active.add(run);
  }

  // Await the dispatched children (the drain-pump pattern: the daemon event loop stays free —
  // runDrain is async — and the pump reschedules itself as soon as this resolves).
  while (active.size) await Promise.race(active);

  return { ran: dispatched, skipped: dispatched ? null : (skipReason || 'no_spawn_decisions'), drains };
}

// ---- executor factory ----------------------------------------------------------------------

/**
 * Build the executor facade daemon.js hands to createHeadlessDrainRunner (a second runner instance
 * over the SHARED headless-drain governor — same backoff, same concurrency surface, zero runner
 * changes).
 *
 * @param {object} hooks
 *   @param {Map}      hooks.loops  — the daemon's loop registry.
 *   @param {Function} hooks.decide — () => decideAll() decisions (caller persists the registry,
 *                                    mirroring the /next-action route's decideAll(); saveLoops()).
 *   plus any runDueSpawns seam override (tests).
 */
function createSpawnExecutor(hooks = {}) {
  const governor = hooks.governor || headlessDrain._governor;
  return {
    _governor: governor,
    runDueSpawns: (state) => runDueSpawns(state, hooks),
    // Facade parity with headless-drain so createHeadlessDrainRunner can pump this executor.
    runDueDrains: (state) => runDueSpawns(state, hooks),
  };
}

module.exports = {
  SPAWN_EXECUTOR_KEY,
  HEADLESS_WORKER_PREFIX,
  PLANNER_DRAIN_KEY,
  createSpawnExecutor,
  runDueSpawns,
  headlessDriverEnabled,
  selfPlanEnabled,
  resolveSpawnBackend,
  workerAgentId,
  workerTimeoutMs,
  buildHandoffEnvelope,
  buildWorkerPrompt,
  // planner surface (drained-DAG plan/optimize execution)
  plannerTimeoutMs,
  plannerCooldownMs,
  hasLivePlannerLease,
  acquirePlannerLease,
  plannerOnCooldown,
  markPlannerRan,
  buildPlannerPrompt,
};
