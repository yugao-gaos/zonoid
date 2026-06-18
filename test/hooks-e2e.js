#!/usr/bin/env node
'use strict';
// End-to-end verification of the Node hooks (hooks/*.js) against a LIVE daemon.
//
// For each hook it spawns `node hooks/<name>.js`, pipes a realistic Claude Code hook payload on
// stdin, and asserts the exit code + stdout, plus the daemon-side effect where observable. Uses
// throwaway non-"off" session ids so the per-conversation opt-out marker can't mask a hook, and
// cleans up its own session markers at the end.
//
//   node test/hooks-e2e.js        # exit 0 if all assertions pass, 1 otherwise

const { spawnSync } = require('child_process');
const http = require('http');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { startHookStub } = require('./support/hook-http-stub');

const PORT = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
const ROOT = path.join(__dirname, '..');
const HOOKS = path.join(ROOT, 'hooks');
const CODEX_HOOKS = path.join(ROOT, 'adapters', 'codex', 'hooks');
const SESS = path.join(process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'orchestrator'), 'sessions');

let pass = 0, fail = 0; const fails = [];
function check(label, cond, detail) {
  if (cond) { pass++; console.log(`  PASS  ${label}`); }
  else { fail++; fails.push(label); console.log(`  FAIL  ${label}${detail ? '  — ' + detail : ''}`); }
}
function info(label, v) { console.log(`  ··    ${label}: ${v}`); }

function daemon(method, p, body) {
  return new Promise((resolve) => {
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    // Use a generous timeout — the live daemon may be slow under load on Windows.
    const req = http.request({ host: '127.0.0.1', port: PORT, path: p, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {}, timeout: 8000 },
      (res) => { let o = ''; res.setEncoding('utf8'); res.on('data', d => o += d); res.on('end', () => { let j = null; try { j = JSON.parse(o); } catch {} resolve({ status: res.statusCode, text: o, json: j }); }); });
    req.on('error', (e) => resolve({ status: 0, text: String(e), json: null }));
    req.on('timeout', () => { req.destroy(); resolve({ status: 0, text: 'timeout', json: null }); });
    if (data) req.write(data); req.end();
  });
}
function runHook(name, payload, env) {
  const res = spawnSync(process.execPath, [path.join(HOOKS, name)], {
    input: payload === undefined ? '' : JSON.stringify(payload), encoding: 'utf8', timeout: 8000,
    env: { ...process.env, ...(env || {}) },
  });
  return { code: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}
// Like runHook but with a generous timeout for hooks that talk to a potentially slow live daemon.
function runHookLong(name, payload, env, timeoutMs = 30000) {
  const res = spawnSync(process.execPath, [path.join(HOOKS, name)], {
    input: payload === undefined ? '' : JSON.stringify(payload), encoding: 'utf8', timeout: timeoutMs,
    env: { ...process.env, ...(env || {}) },
  });
  return { code: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}
// Run a hook with a fast in-process stub daemon instead of the live (potentially slow) daemon.
// config follows hook-http-stub-child.js shape: { activeClaim, sessionInfo, dispatcherChildren, taskDetails }.
function runHookWithStub(name, payload, config, extraEnv = {}) {
  const stub = startHookStub(config);
  try {
    const res = spawnSync(process.execPath, [path.join(HOOKS, name)], {
      input: payload === undefined ? '' : JSON.stringify(payload), encoding: 'utf8', timeout: 8000,
      env: { ...process.env, ...stub.env(), ...extraEnv },
    });
    return { code: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
  } finally {
    stub.stop();
  }
}
function runScript(scriptPath, payload, env) {
  const res = spawnSync('bash', [scriptPath], {
    input: payload === undefined ? '' : JSON.stringify(payload), encoding: 'utf8', timeout: 8000,
    env: { ...process.env, ...(env || {}) },
  });
  return { code: res.status, stdout: (res.stdout || '').trim(), stderr: (res.stderr || '').trim() };
}
function curlHits(logPath) {
  try { return fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean); }
  catch { return []; }
}
function makeShellHookEnv() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-hook-stubs-'));
  const dataDir = path.join(dir, 'data');
  const logPath = path.join(dir, 'curl.log');
  const jq = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const input = fs.readFileSync(0, 'utf8');
if (args.includes('-Rs')) { process.stdout.write(JSON.stringify(input)); process.exit(0); }
const filter = args.filter((a) => a !== '-r').join(' ');
let json = {};
try { json = JSON.parse(input || '{}'); } catch {}
let out = '';
if (filter.includes('.tool_name')) out = json.tool_name || '';
else if (filter.includes('.session_id')) out = json.session_id || '';
else if (filter.includes('.tool_input.task_key')) out = json.tool_input && json.tool_input.task_key || '';
else if (filter.includes('[.ready')) out = Array.isArray(json.ready) ? json.ready.map((x) => x && x.label).filter(Boolean).join(', ') : '';
process.stdout.write(String(out));
`;
  const curl = `#!/usr/bin/env node
const fs = require('fs');
const args = process.argv.slice(2);
const line = args.join(' ');
fs.appendFileSync(process.env.CURL_LOG, line + '\\n');
if (line.includes('/ready')) process.stdout.write(JSON.stringify({ ready: [{ label: 'stub-ready' }] }));
`;
  fs.writeFileSync(path.join(dir, 'jq'), jq, { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'curl'), curl, { mode: 0o755 });
  return {
    env: {
      PATH: `${dir}:${process.env.PATH || ''}`,
      CLAUDE_PLUGIN_DATA: dataDir,
      CURL_LOG: logPath,
      ORCH_PORT: '19999',
    },
    logPath,
    cleanup: () => fs.rmSync(dir, { recursive: true, force: true }),
  };
}
function jsonOut(r) { try { return JSON.parse(r.stdout); } catch { return null; } }
function ctxOf(r) { const j = jsonOut(r); return (j && j.hookSpecificOutput && j.hookSpecificOutput.additionalContext) || ''; }
function mkOff(sid) { fs.mkdirSync(SESS, { recursive: true }); fs.writeFileSync(path.join(SESS, `${sid}.off`), ''); }

(async () => {
  const health = await daemon('GET', '/health');
  console.log(`daemon /health: status=${health.status} ok=${health.json && health.json.ok} phase=${health.json && health.json.phase}\n`);
  if (!health.json || !health.json.ok) { console.error('Daemon not healthy — aborting e2e.'); process.exit(1); }

  // ── statusline (no stdin) ──────────────────────────────────────────────────
  console.log('statusline.js');
  { const r = runHook('statusline.js');
    check('exit 0', r.code === 0, `code=${r.code}`);
    check('renders status line', r.stdout.startsWith('🕸'), JSON.stringify(r.stdout.slice(0, 40)));
    info('output', r.stdout.replace(//g, '<ESC>')); }

  // ── classify (toggle on/off, classify round-trip, opt-out suppression) ──────
  console.log('classify.js');
  { const on = runHook('classify.js', { session_id: 'e2e-on', prompt: 'orch on' });
    check('orch on -> Enabled ctx', /Enabled/.test(ctxOf(on)), JSON.stringify(on.stdout.slice(0, 60)));
    const off = runHook('classify.js', { session_id: 'e2e-off', prompt: 'orch off' });
    check('orch off -> Disabled ctx', /Disabled/.test(ctxOf(off)), JSON.stringify(off.stdout.slice(0, 60)));
    const clf = runHook('classify.js', { session_id: 'e2e-clf', prompt: 'refactor the retry logic in the http client' });
    check('normal prompt exit 0 + valid/empty JSON', clf.code === 0 && (clf.stdout === '' || jsonOut(clf) !== null), `code=${clf.code}`);
    info('classify ctx len', String(ctxOf(clf).length));
    mkOff('e2e-supp');
    const supp = runHook('classify.js', { session_id: 'e2e-supp', prompt: 'hello there' });
    check('opt-out suppresses classify (no ctx)', supp.code === 0 && supp.stdout === '', `stdout=${JSON.stringify(supp.stdout.slice(0,40))}`); }

  // ── orch-gate (allow exempt / deny no-claim / opt-out / gate-off) ───────────
  // Uses a fast in-process stub instead of the live daemon so 600ms timeouts in the hook
  // don't fail-open on a slow machine (daemon may take seconds to respond under load).
  console.log('orch-gate.js');
  { const gStub = startHookStub({ activeClaim: { claimed: false }, sessionInfo: { is_subagent: false } });
    try {
      check('exempt path allowed', runHook('orch-gate.js', { session_id: 'e2e-g', tool_input: { file_path: '/x/.mcp.json', new_string: 'y' } }, gStub.env()).code === 0);
      const d = runHook('orch-gate.js', { session_id: 'e2e-g2', tool_input: { file_path: '/x/src/app.js', new_string: 'a real edit' } }, gStub.env());
      check('no-claim source write denied (exit 2)', d.code === 2, `code=${d.code}`);
      check('deny carries orch-gate stderr', /orch-gate/.test(d.stderr));
      mkOff('e2e-goff');
      check('opt-out marker allows', runHook('orch-gate.js', { session_id: 'e2e-goff', tool_input: { file_path: '/x/src/app.js', new_string: 'z' } }, gStub.env()).code === 0);
      check('ORCH_GATE_OFF=1 allows', runHook('orch-gate.js', { session_id: 'e2e-g3', tool_input: { file_path: '/x/src/app.js', new_string: 'z' } }, { ...gStub.env(), ORCH_GATE_OFF: '1' }).code === 0);
    } finally { gStub.stop(); } }

  // ── orch-gate-bash (read allow / write deny / git + daemon exemptions) ───────
  // Same rationale: use a fast stub so the hook's 600ms timeouts don't fail-open.
  console.log('orch-gate-bash.js');
  { const bStub = startHookStub({ activeClaim: { claimed: false }, sessionInfo: { is_subagent: false } });
    try {
      check('read-only cmd allowed', runHook('orch-gate-bash.js', { session_id: 'e2e-b', tool_input: { command: 'ls -la' } }, bStub.env()).code === 0);
      check('git commit exempt', runHook('orch-gate-bash.js', { session_id: 'e2e-b', tool_input: { command: 'git commit -m wip' } }, bStub.env()).code === 0);
      // daemon-curl exemption uses the stub port (the hook exempts curl to its own ORCH_PORT)
      const stubPort = bStub.env().ORCH_PORT;
      check('daemon curl exempt', runHook('orch-gate-bash.js', { session_id: 'e2e-b', tool_input: { command: `curl -s localhost:${stubPort}/ping` } }, bStub.env()).code === 0);
      check('/tmp redirect denied without claim', runHook('orch-gate-bash.js', { session_id: 'e2e-b', tool_input: { command: 'echo hi > /tmp/x.txt' } }, bStub.env()).code === 2);
      check('no-claim redirect write denied (exit 2)', runHook('orch-gate-bash.js', { session_id: 'e2e-b2', tool_input: { command: 'echo hi > /x/out.txt' } }, bStub.env()).code === 2);
      check('no-claim cp-to-source denied (exit 2)', runHook('orch-gate-bash.js', { session_id: 'e2e-b2', tool_input: { command: 'cp a.js /x/main.js' } }, bStub.env()).code === 2);
    } finally { bStub.stop(); } }

  // ── orch-stop (allow when no stop requested) ────────────────────────────────
  console.log('orch-stop.js');
  { const r = runHook('orch-stop.js', { session_id: 'e2e-stop', tool_name: 'Read', tool_input: {} });
    check('no stop -> allow (exit 0)', r.code === 0, `code=${r.code}`); }

  // ── subagent-start / subagent-stop (observe daemon agent counts) ────────────
  // Use /agents (global, no workspace param required) instead of /state (requires ?workspace=).
  console.log('subagent-start.js / subagent-stop.js');
  { const agentId = `e2e-agent-${Date.now()}`;
    const beforeList = (await daemon('GET', '/agents')).json;
    const before0 = (beforeList && beforeList.agents) || [];
    const start = runHook('subagent-start.js', { session_id: 'e2e-parent', agent_id: agentId, agent_type: 'general', transcript_path: '/tmp/e2e.jsonl' });
    check('subagent-start exit 0', start.code === 0, `code=${start.code}`);
    const midList = (await daemon('GET', '/agents')).json;
    const mid0 = (midList && midList.agents) || [];
    const found = mid0.find((a) => a.agent_id === agentId);
    info('agents total before/after start', `${before0.length} -> ${mid0.length}`);
    check('daemon registered the agent (total or running grew)', mid0.length > before0.length || !!found, `before=${before0.length} after=${mid0.length} found=${!!found}`);
    const stop = runHook('subagent-stop.js', { session_id: 'e2e-parent', agent_id: agentId });
    check('subagent-stop exit 0', stop.code === 0, `code=${stop.code}`);
    const afterList = (await daemon('GET', '/agents')).json;
    const after0 = (afterList && afterList.agents) || [];
    const foundAfter = after0.find((a) => a.agent_id === agentId && a.state === 'running');
    info('agents after stop', JSON.stringify(after0.filter((a) => a.agent_id === agentId).map((a) => ({ agent_id: a.agent_id, state: a.state }))));
    check('stop moved agent out of running', !foundAfter, `foundRunning=${!!foundAfter}`);
    // opt-out: an off session must NOT register
    const offAgentId = `e2e-agent-OFF-${Date.now()}`;
    mkOff('e2e-suboff');
    const sbList = (await daemon('GET', '/agents')).json; const sb0 = (sbList && sbList.agents) || [];
    runHook('subagent-start.js', { session_id: 'e2e-suboff', agent_id: offAgentId, agent_type: 'general' });
    const saList = (await daemon('GET', '/agents')).json; const sa0 = (saList && saList.agents) || [];
    const foundOff = sa0.find((a) => a.agent_id === offAgentId);
    check('opt-out session does NOT register an agent', !foundOff, `found=${!!foundOff}`); }

  // ── post-agent (ready-task nudge) ───────────────────────────────────────────
  console.log('post-agent.js');
  { const r = runHook('post-agent.js', { session_id: 'e2e-pa' });
    check('exit 0 + (empty or valid nudge JSON)', r.code === 0 && (r.stdout === '' || jsonOut(r) !== null), `code=${r.code}`);
    if (r.stdout) info('nudge', ctxOf(r).slice(0, 80)); else info('nudge', '(no ready tasks for this session)'); }

  // ── suggest-links (quarantine reminder always fires) ────────────────────────
  console.log('suggest-links.js');
  { const r = runHook('suggest-links.js', { session_id: 'e2e-sl', tool_name: 'TaskCreate', tool_response: 'Task #4242 created successfully: probe' });
    check('exit 0', r.code === 0, `code=${r.code}`);
    check('emits QUARANTINED reminder', /QUARANTINED/.test(ctxOf(r)), JSON.stringify(r.stdout.slice(0, 60)));
    const none = runHook('suggest-links.js', { session_id: 'e2e-sl2', tool_response: 'no task id here' });
    check('no task id -> exit 0 no output', none.code === 0 && none.stdout === ''); }

  // ── orch-posttool-starttask (filters on tool_name, POSTs claim-session) ──────
  console.log('orch-posttool-starttask.js');
  { check('non start_task tool -> noop exit 0', runHook('orch-posttool-starttask.js', { session_id: 'e2e-pt', tool_name: 'Bash', tool_input: { command: 'ls' } }).code === 0);
    const r = runHook('orch-posttool-starttask.js', { session_id: 'e2e-pt', tool_name: 'mcp__orchestrator-graph__start_task', tool_input: { task_key: 'e2e/probe-task' } });
    check('start_task -> exit 0 (claim-session posted)', r.code === 0, `code=${r.code}`);
    const claim = await daemon('GET', '/active-claim?session=e2e-pt');
    info('/active-claim after claim-session', claim.text.slice(0, 80)); }

  // ── Codex adapter post hooks (actual Codex + legacy matcher names) ─────────
  console.log('codex adapter post hooks');
  { const stub = makeShellHookEnv();
    try {
      const startScript = path.join(CODEX_HOOKS, 'post-start-task.sh');
      for (const toolName of ['mcp__orchestrator-graph__start_task', 'mcp__orchestrator_graph__start_task', 'start_task']) {
        const before = curlHits(stub.logPath).length;
        const r = runScript(startScript, { session_id: `e2e-cdx-start-${before}`, tool_name: toolName, tool_input: { task_key: `e2e/${before}` } }, stub.env);
        const hits = curlHits(stub.logPath);
        const last = hits[hits.length - 1] || '';
        check(`post-start accepts ${toolName}`, r.code === 0 && hits.length === before + 1 && last.includes('/overlay/claim-session'), `code=${r.code} hits=${hits.length} last=${last}`);
      }
      { const before = curlHits(stub.logPath).length;
        const r = runScript(startScript, { session_id: 'e2e-cdx-start-noop', tool_name: 'Bash', tool_input: { command: 'ls' } }, stub.env);
        check('post-start ignores non-start tool', r.code === 0 && curlHits(stub.logPath).length === before, `code=${r.code}`); }

      const lifecycleScript = path.join(CODEX_HOOKS, 'post-lifecycle.sh');
      for (const toolName of ['spawn_agents.background', 'mcp__orchestrator-graph__complete_task', 'mcp__orchestrator_graph__complete_task', 'complete_task', 'Agent', 'Task']) {
        const before = curlHits(stub.logPath).length;
        const r = runScript(lifecycleScript, { session_id: `e2e-cdx-life-${before}`, tool_name: toolName }, stub.env);
        const hits = curlHits(stub.logPath);
        const last = hits[hits.length - 1] || '';
        check(`post-lifecycle accepts ${toolName}`, r.code === 0 && hits.length === before + 1 && last.includes('/ready?session='), `code=${r.code} hits=${hits.length} last=${last}`);
      }
      { const before = curlHits(stub.logPath).length;
        const r = runScript(lifecycleScript, { session_id: 'e2e-cdx-life-noop', tool_name: 'Bash' }, stub.env);
        check('post-lifecycle ignores unrelated tool', r.code === 0 && curlHits(stub.logPath).length === before, `code=${r.code}`); }
    } finally {
      stub.cleanup();
    } }

  // ── start-daemon (re-register workspace; daemon stays healthy) ───────────────
  // Uses runHookLong: on Windows the live daemon may be slow to respond, and
  // start-daemon.js loops waiting for it — needs more than the default 8s budget.
  console.log('start-daemon.js');
  { const r = runHookLong('start-daemon.js', { cwd: path.join(__dirname, '..'), session_id: 'e2e-sd', transcript_path: '/tmp/e2e.jsonl', harness: 'claude' });
    check('exit 0', r.code === 0, `code=${r.code}`);
    const h = await daemon('GET', '/health');
    check('daemon still healthy after', !!(h.json && h.json.ok), `status=${h.status}`); }

  // ── cleanup our throwaway session markers ───────────────────────────────────
  try { for (const f of fs.readdirSync(SESS)) if (f.startsWith('e2e-')) fs.rmSync(path.join(SESS, f), { force: true }); } catch {}

  console.log(`\n========================================`);
  console.log(`E2E RESULT: ${pass} passed, ${fail} failed`);
  if (fail) console.log(`FAILURES: ${fails.join(' | ')}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('e2e crashed:', e); process.exit(1); });
