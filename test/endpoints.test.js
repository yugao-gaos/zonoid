/**
 * Endpoint coverage for previously-untested daemon routes:
 *   1. GET  /active-claim          — the read the orch-gate write-lock hooks trust
 *   2. POST /analytics/tool-call   — MCP tool-usage beacon (+ /analytics/tools report shape)
 *   3. POST /context-classify      — classify endpoint used by hooks/classify.sh
 *   4. POST /task/measure          — metric measurement write (happy + rejections)
 *   5. op_id replay dedup          — duplicate mutating POST replays, applies exactly once
 *
 * Spawns a SANDBOXED daemon on a private port (never the live one at 8787), with a tmp
 * CLAUDE_PLUGIN_DATA and a tmp workspace — same pattern as test/supersede-roundtrip.test.js.
 * Native task fixtures use clearly-fake random-UUID sessions under ~/.claude (the only place
 * lib/native-tasks reads from) and are removed in the finally block — never touches real sessions.
 * Run: node test/endpoints.test.js
 */
'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const { spawn, execSync } = require('child_process');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-endpoints-base-')));
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-endpoints-ws-')));
const REPO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-endpoints-repo-')));
const NOT_A_REPO = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-endpoints-norepo-')));

// Reuse the already-downloaded embedding weights if present (see supersede-roundtrip.test.js);
// absent => embed() degrades to null and lexical fallbacks kick in everywhere.
try {
  const realModels = path.join(os.homedir(), '.claude', 'orchestrator', 'models');
  if (fs.existsSync(realModels)) fs.symlinkSync(realModels, path.join(SANDBOX, 'models'));
} catch { /* lexical fallback is fine */ }

// Port range 19550-19649 — unused by other tests (they use 18790/18820/18980/18990/19700+/19900).
const PORT = 19550 + Math.floor(Math.random() * 100);
const BASE = `http://127.0.0.1:${PORT}`;

// Native-task fixtures: lib/native-tasks reads ONLY ~/.claude/projects/<encoded-ws>/ (session
// listing) and ~/.claude/tasks/<session>/ (task files). WS is a unique tmp dir, so its encoded
// projects dir cannot collide with any real workspace, and the session ids are fresh UUIDs.
const encodeWorkspace = (p) => String(p).replace(/[/.]/g, '-');
const PROJECTS_DIR = path.join(os.homedir(), '.claude', 'projects', encodeWorkspace(WS));
const SID_A = crypto.randomUUID();   // session that claims a task
const SID_B = crypto.randomUUID();   // session with a task but NO claim
const SID_C = crypto.randomUUID();   // subagent session mapped via /agent/start subagent_session
const TASKS_A = path.join(os.homedir(), '.claude', 'tasks', SID_A);
const TASKS_B = path.join(os.homedir(), '.claude', 'tasks', SID_B);
const KEY_A = `${SID_A}/1`;
const KEY_B = `${SID_B}/1`;

async function post(p, body, raw) {
  const res = await fetch(`${BASE}${p}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: raw !== undefined ? raw : JSON.stringify(body),
  });
  return { status: res.status, body: await res.json() };
}

async function get(p) {
  const res = await fetch(`${BASE}${p}`);
  return { status: res.status, body: await res.json() };
}

async function waitForPing(ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await get('/ping'); if (r.body && r.body.ok) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

test('untested daemon endpoints', async () => {
  // ── fixtures: two fake native sessions wired to the tmp workspace ─────────
  fs.mkdirSync(PROJECTS_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJECTS_DIR, `${SID_A}.jsonl`), '');
  fs.writeFileSync(path.join(PROJECTS_DIR, `${SID_B}.jsonl`), '');
  fs.mkdirSync(TASKS_A, { recursive: true });
  fs.mkdirSync(TASKS_B, { recursive: true });
  fs.writeFileSync(path.join(TASKS_A, '1.json'), JSON.stringify({ id: '1', subject: 'gate probe task', status: 'pending' }));
  fs.writeFileSync(path.join(TASKS_B, '1.json'), JSON.stringify({ id: '1', subject: 'bystander task', status: 'pending' }));
  execSync('git init -q', { cwd: REPO });

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT), ORCH_TOKEN: '' },
    stdio: 'ignore',
  });
  try {
    assert.ok(await waitForPing(), 'sandboxed daemon came up');
    assert.equal((await post('/workspace', { path: WS })).body.ok, true, 'workspace pinned');

    // ════ 1. GET /active-claim — what the orch-gate hooks trust ════════════
    // No claim yet -> locked.
    let r = await get(`/active-claim?session=${SID_A}`);
    assert.equal(r.status, 200, 'active-claim: 200');
    assert.equal(r.body.claimed, false, 'no claim yet -> locked');
    assert.equal(r.body.claims.length, 0, 'no claim yet -> empty claims');

    // Unwired quarantine: a freshly-seen edge-less task refuses the in_progress claim until
    // it is wired or declared a root (the same contract worker agents hit via start_task).
    r = await post('/overlay/status', { key: KEY_A, status: 'in_progress', agent_id: 'gate-agent' });
    assert.equal(r.status, 409, 'unwired task: claim refused with 409');
    assert.equal((await post('/mark-root', { task_key: KEY_A, reason: 'endpoint test root' })).body.ok, true, 'mark-root clears quarantine');
    r = await post('/overlay/status', { key: KEY_A, status: 'in_progress', agent_id: 'gate-agent' });
    assert.equal(r.body.ok, true, 'claim lands after mark-root');

    // Valid in_progress claim -> unlocked for ITS session only.
    r = await get(`/active-claim?session=${SID_A}`);
    assert.equal(r.body.claimed, true, 'claiming session -> unlocked');
    assert.equal(r.body.claims.length, 1, 'exactly one claim');
    assert.equal(r.body.claims[0].key, KEY_A, 'claim carries the task key');
    assert.equal(r.body.claims[0].agent_id, 'gate-agent', 'claim carries the agent id');

    // A DIFFERENT session must stay locked (has its own task, but no claim).
    r = await get(`/active-claim?session=${SID_B}`);
    assert.equal(r.body.claimed, false, "another session's claim does not unlock");
    assert.equal(r.body.claims.length, 0, 'other session sees zero claims');

    // Unfiltered read lists all in_progress claims.
    r = await get('/active-claim');
    assert.equal(r.body.claimed, true, 'unfiltered read sees the claim');
    assert.ok(r.body.claims.some((c) => c.key === KEY_A), 'unfiltered claims include the task');

    // Secondary lookup: agent's subagent_session maps the claim to the worker's own session id.
    assert.equal((await post('/agent/start', { agent_id: 'gate-agent', subagent_session: SID_C })).body.ok, true, 'agent registered with subagent_session');
    r = await get(`/active-claim?session=${SID_C}`);
    assert.equal(r.body.claimed, true, 'subagent session unlocks via agent_id mapping');

    // Released claim re-locks.
    assert.equal((await post('/overlay/status', { key: KEY_A, status: 'done', agent_id: 'gate-agent', summary: 'released' })).body.ok, true, 'claim released (done)');
    r = await get(`/active-claim?session=${SID_A}`);
    assert.equal(r.body.claimed, false, 'released claim -> locked again');


    // ════ 1b. GET /session-info — subagent vs parent session classification ═
    const SID_PARENT = crypto.randomUUID();
    r = await get(`/session-info?session=${SID_PARENT}`);
    assert.equal(r.body.is_subagent, false, 'empty registry -> not subagent');

    await post('/agent/start', {
      agent_id: 'misclass-agent',
      session: SID_PARENT,
      subagent_session: SID_PARENT,
    });
    r = await get(`/session-info?session=${SID_PARENT}`);
    assert.equal(r.body.is_subagent, false, 'subagent_session===session must not mark parent as subagent');

    await post('/agent/start', {
      agent_id: 'real-sub-agent',
      session: SID_PARENT,
      subagent_session: SID_C,
    });
    r = await get(`/session-info?session=${SID_C}`);
    assert.equal(r.body.is_subagent, true, 'distinct running subagent_session marks worker session');

    await post('/agent/done', { agent_id: 'real-sub-agent' });
    r = await get(`/session-info?session=${SID_C}`);
    assert.equal(r.body.is_subagent, false, 'done agent no longer classifies session as subagent');

    // ════ 2. POST /analytics/tool-call — usage beacon ══════════════════════
    const TOOL = `endpoint_test_tool_${Date.now()}`;
    r = await post('/analytics/tool-call', { tool: TOOL });
    assert.equal(r.status, 200, 'tool-call beacon: 200');
    assert.equal(r.body.ok, true, 'tool-call beacon: ok');
    assert.equal((await post('/analytics/tool-call', { tool: TOOL, error: true })).body.ok, true, 'tool-call beacon with error flag: ok');
    r = await post('/analytics/tool-call', {});
    assert.equal(r.status, 400, 'missing tool -> 400');

    r = await get('/analytics/tools');
    assert.equal(r.body.ok, true, 'analytics report: ok');
    const row = (r.body.tools || []).find((t) => t.name === TOOL);
    assert.ok(row, 'recorded tool shows in the report');
    assert.equal(row.total, 2, 'counter landed: total 2');
    assert.equal(row.errors, 1, 'error flag counted once');
    assert.equal(row.registered, false, 'non-registry tool flagged unregistered');
    assert.equal(row.last7d, 2, 'rolling 7d window counts both calls');
    assert.ok(row.last_called, 'last_called stamped');

    // ════ 3. POST /context-classify — hook classify endpoint ═══════════════
    r = await post('/context-classify', { prompt: 'fix the login button color' });
    assert.equal(r.status, 200, 'classify happy path: 200');
    assert.equal(typeof r.body.rag_score, 'number', 'rag_score is a number');
    assert.equal(typeof r.body.dag_score, 'number', 'dag_score is a number');
    assert.ok(['inject', 'scaffold', 'abstain'].includes(r.body.gate_decision), 'gate_decision is one of inject/scaffold/abstain');
    assert.ok(Math.abs(r.body.complexity - 0.2) < 1e-9, 'short prompt -> complexity 0.2');

    r = await post('/context-classify', { prompt: 'audit the auth flow' });
    assert.ok(Math.abs(r.body.complexity - 0.4) < 1e-9, 'audit keyword bumps complexity +0.2');

    r = await post('/context-classify', {});
    assert.equal(r.status, 400, 'missing prompt -> 400 (controlled)');
    r = await post('/context-classify', null, '{{{not json');
    assert.equal(r.status, 400, 'malformed JSON body -> 400, not an uncontrolled 500');

    // ════ 4. POST /task/measure — measurement write ═════════════════════════
    const SPEC = { metric: 'answer', direction: 'min', measure_command: 'echo 42', parse: 'last_number' };
    assert.equal((await post('/task/metric', { key: KEY_A, spec: SPEC })).body.ok, true, 'metric spec set');
    r = await post('/task/measure', { key: KEY_A, baseline: true, repo_path: REPO });
    assert.equal(r.status, 200, 'measure happy path: 200');
    assert.equal(r.body.ok, true, 'measure happy path: ok');
    assert.equal(r.body.baseline, true, 'baseline flag echoed');
    assert.equal(r.body.measurement.baseline.value, 42, 'measured value landed on the node');
    assert.ok(r.body.measurement.baseline.measured_at, 'measurement is timestamped');
    // The write is readable back via /task/detail (state actually landed).
    r = await get(`/task/detail?key=${encodeURIComponent(KEY_A)}`);
    assert.equal(r.body.measurement.baseline.value, 42, 'measurement persisted on the task detail');

    r = await post('/task/measure', {});
    assert.equal(r.status, 400, 'missing key -> 400');
    r = await post('/task/measure', { key: KEY_B, baseline: true, repo_path: REPO });
    assert.equal(r.status, 409, 'no metric spec on task -> 409');
    r = await post('/task/measure', { key: KEY_A, baseline: true, repo_path: NOT_A_REPO });
    assert.equal(r.status, 409, 'non-git repo target -> 409');
    assert.equal((await post('/task/metric', { key: KEY_B, spec: { metric: 'm', direction: 'min', measure_command: 'exit 3' } })).body.ok, true, 'failing spec set');
    r = await post('/task/measure', { key: KEY_B, baseline: true, repo_path: REPO });
    assert.equal(r.status, 422, 'failing measure command -> 422 (controlled)');

    // ════ 5. op_id replay dedup on mutating POSTs ══════════════════════════
    // /overlay/knowledge appends per call — the count proves apply-exactly-once.
    const OP = crypto.randomUUID();
    const kBody = { key: KEY_A, item: { type: 'note', text: 'replay probe' }, op_id: OP };
    const k1 = await post('/overlay/knowledge', kBody);
    assert.equal(k1.status, 200, 'knowledge attach: 200');
    assert.equal(k1.body.count, 1, 'first apply -> count 1');
    const k2 = await post('/overlay/knowledge', kBody);
    assert.equal(k2.status, 200, 'duplicate op_id: replayed with same status');
    assert.deepEqual(k2.body, k1.body, 'duplicate op_id: identical response body (replay, count still 1)');
    // Verify by reading state: the item landed exactly once.
    r = await get(`/task/detail?key=${encodeURIComponent(KEY_A)}`);
    assert.equal(r.body.knowledge.length, 1, 'mutation applied exactly once (state read-back)');
    // A DIFFERENT op_id with the same payload is a new logical request -> applies again.
    const k3 = await post('/overlay/knowledge', { ...kBody, op_id: crypto.randomUUID() });
    assert.equal(k3.body.count, 2, 'fresh op_id -> mutation applies (count 2)');

    // /overlay/note mints a new id per call — replay must return the SAME key, one note total.
    const NOP = crypto.randomUUID();
    const nBody = { title: 'endpoint replay note', summary: 'op replay dedup probe', op_id: NOP };
    const n1 = await post('/overlay/note', nBody);
    assert.equal(n1.body.ok, true, 'note created');
    const n2 = await post('/overlay/note', nBody);
    assert.equal(n2.body.key, n1.body.key, 'duplicate op_id -> same note key (no second note minted)');
    r = await get(`/peek?workspace=${encodeURIComponent(WS)}`);
    const notes = r.body.tasks.filter((t) => t.kind === 'note');
    assert.equal(notes.length, 1, 'exactly one note node exists after the duplicate');
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    for (const d of [SANDBOX, WS, REPO, NOT_A_REPO, PROJECTS_DIR, TASKS_A, TASKS_B]) {
      try { fs.rmSync(d, { recursive: true, force: true }); } catch { /* */ }
    }
  }
});
