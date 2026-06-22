#!/usr/bin/env node
// E2E (T4, level 2 — product round-trip): a full dispatcher→worker handoff against a LIVE daemon.
//
// Exercises the whole structured-handoff contract end to end on a metric-carrying task:
//   dispatcher builds a handoff_envelope  → worker branch_task (worktree)
//   → start_task (in_progress, self-register-on-claim, NO SubagentStart hook)
//   → write + commit inside the worktree   → measure_task (records metric)
//   → complete_task carrying a structured task_result with metric_measurements.
//
// Asserts:
//   (1) the dispatcher-built handoff_envelope validates against schemas/handoff.v1.schema.json
//       (#/definitions/handoff_envelope) BEFORE dispatch — the slotted fields are well-formed;
//   (2) the worker self-registers on the hook-less claim (no /agent/start ever called) and the
//       claim succeeds only because branch_task registered a worktree (the delegation proof);
//   (3) the terminal complete_task carries a task_result that validates against
//       #/definitions/task_result with has_metric_spec injected — the metric conditional is met;
//   (4) the daemon accepts that terminal write (200) and the task lands `tested`.
//
// ajv is NOT a repo dependency (it was not as of T1), so this validates structurally with a small
// JSON-Schema walker (subset: type, const, enum, required, properties, items, additionalProperties,
// pattern, $ref, allOf/if/then) — the same plain-JS-over-JSON approach the rest of test/ uses.
// Run: node test/handoff-roundtrip.test.js
'use strict';
if (process.env.ZONOID_SKIP_LIVE) { console.log('SKIP  handoff-roundtrip suite: ZONOID_SKIP_LIVE set'); process.exit(0); }
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFileSync } = require('child_process');
const { spawn } = require('child_process');
const git = require('../lib/git');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-handoff-rt-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const PORT = 19170 + Math.floor(Math.random() * 200);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-handoff-rt-ws-')));

const SESSION = 'aaaaaaaa-feedface-0000-4000-800000000044';
const { encodeWorkspace } = require('../lib/native-tasks');
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', encodeWorkspace(WS));
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', SESSION);
const K = (id) => `${SESSION}/${id}`;
const METRIC = { metric: 'score', direction: 'max', measure_command: 'echo 7' };

const SCHEMA = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'schemas', 'handoff.v1.schema.json'), 'utf8'));

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

// --- Minimal JSON-Schema validator (draft-07 subset used by handoff.v1) ---------------------
// Returns an array of error strings (empty = valid). Supports the keywords the contract uses.
function deref(ref) {
  // only local #/definitions/<name> refs appear in this schema
  const m = /^#\/definitions\/(.+)$/.exec(ref);
  if (!m) throw new Error('unsupported $ref ' + ref);
  return SCHEMA.definitions[m[1]];
}
function validate(node, sch, p = '') {
  const errs = [];
  if (sch.$ref) return validate(node, deref(sch.$ref), p);
  if (sch.const !== undefined && node !== sch.const) errs.push(`${p}: expected const ${JSON.stringify(sch.const)}, got ${JSON.stringify(node)}`);
  if (sch.enum && !sch.enum.includes(node)) errs.push(`${p}: ${JSON.stringify(node)} not in enum`);
  if (sch.type) {
    const t = Array.isArray(node) ? 'array' : node === null ? 'null' : typeof node;
    const want = sch.type === 'integer' ? 'number' : sch.type;
    if (t !== want) errs.push(`${p}: expected type ${sch.type}, got ${t}`);
  }
  if (sch.pattern && typeof node === 'string' && !new RegExp(sch.pattern).test(node)) errs.push(`${p}: ${JSON.stringify(node)} fails pattern ${sch.pattern}`);
  if (sch.type === 'object' || sch.properties || sch.required) {
    if (node && typeof node === 'object' && !Array.isArray(node)) {
      for (const r of sch.required || []) if (!(r in node)) errs.push(`${p}: missing required '${r}'`);
      for (const [k, v] of Object.entries(node)) {
        if (sch.properties && sch.properties[k]) errs.push(...validate(v, sch.properties[k], `${p}.${k}`));
        else if (sch.additionalProperties === false) errs.push(`${p}: additional property '${k}' not allowed`);
        else if (sch.additionalProperties && typeof sch.additionalProperties === 'object') errs.push(...validate(v, sch.additionalProperties, `${p}.${k}`));
      }
    }
  }
  if (sch.type === 'array' && Array.isArray(node) && sch.items) {
    node.forEach((el, i) => errs.push(...validate(el, sch.items, `${p}[${i}]`)));
  }
  for (const sub of sch.allOf || []) {
    if (sub.if) {
      const condOk = validate(node, sub.if, p).length === 0;
      if (condOk && sub.then) errs.push(...validate(node, sub.then, p));
      if (!condOk && sub.else) errs.push(...validate(node, sub.else, p));
    } else {
      errs.push(...validate(node, sub, p));
    }
  }
  return errs;
}

function req(method, p, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const r = http.request({ host: '127.0.0.1', port: PORT, path: p, method, headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => { try { resolve({ status: res.statusCode, body: JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}') }); } catch { resolve({ status: res.statusCode, body: {} }); } });
    });
    r.on('error', reject);
    if (data) r.write(data);
    r.end();
  });
}

async function waitForPing(ms = 8000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    try { const r = await req('GET', '/ping'); if (r.status === 200) return true; } catch { /* not up yet */ }
    await new Promise((r) => setTimeout(r, 100));
  }
  return false;
}

(async () => {
  // First: validator self-check — a deliberately malformed envelope MUST be rejected, otherwise
  // the positive assertions below would be vacuous (a validator that accepts everything).
  const badEnvelope = { version: 2, task_key: K(1) }; // wrong const + missing required fields
  ok('validator rejects a malformed handoff_envelope (not vacuous)', validate(badEnvelope, SCHEMA.definitions.handoff_envelope).length > 0);
  // And a metric task_result missing measurements (has_metric_spec injected) MUST fail the conditional.
  ok('validator enforces metric conditional (missing measurements fails)',
    validate({ version: 1, status: 'tested', summary: 's', has_metric_spec: true }, SCHEMA.definitions.task_result).length > 0);

  git.initRepo(WS);
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, `${SESSION}.jsonl`), '');
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  // Task 1: the LIVE-claim round-trip task. Deliberately NON-metric so the metric-mode branch arm
  // (which keys off git.currentBranch of the claim workspace) cannot confound the self-register-on-
  // claim assertion — that arm has its own dedicated coverage in metric-branch-claim.test.js.
  fs.writeFileSync(path.join(TASKS_DIR, '1.json'), JSON.stringify({ id: '1', subject: 'roundtrip handoff', status: 'pending' }));
  // Task 2 is created after the live claim leg below. Keeping the metric sibling out of the
  // initial adoption pass avoids unrelated eager-autowire judging from blocking this claim test.

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    ok('daemon came up', await waitForPing());
    ok('workspace pinned', (await req('POST', '/workspace', { path: WS })).status === 200);
    await req('GET', '/state');
    ok('root declared for claim task', (await req('POST', '/mark-root', { workspace: WS, task_key: K(1) })).status === 200);

    // =================================================================================================
    // LEG A — full live round-trip on the NON-metric task 1:
    //   dispatch (branch_task + build envelope) → hook-less claim (self-register) → write+commit →
    //   terminal complete_task carrying a structured task_result → task lands `tested`.
    // =================================================================================================

    // DISPATCH: dispatcher branches a worktree (registered in overlay.git — the delegation proof),
    // then builds the handoff_envelope it would hand the worker. The branch slot is the real attempt
    // branch returned by branch_task.
    const wt = await req('POST', '/git/worktree', { workspace: WS, key: K(1) });
    ok('attempt worktree created + registered', wt.status === 200 && String(wt.body.branch).startsWith('orch/attempt/'));
    const worktreePath = wt.body.worktree || wt.body.path;

    const envelope = {
      version: 1,
      task_key: K(1),
      agent_id: 'rt-worker',
      branch: wt.body.branch,
      target_repo: WS,
      files_in_scope: ['result.txt'],
      plan_goal: 'Verify the end-to-end handoff round-trip for structured dispatcher→worker contract.',
      sibling_tasks: [{ task_key: K(2), title: 'roundtrip metric handoff' }],
      context_deps: [{ task_key: K(1), summary: 'pre-resolved Tier-1 context for the worker' }],
      return_contract: {
        version: 1,
        status: 'tested',
        summary: 'placeholder return shape',
        files_changed: [],
        tests_run: '',
        decisions: [],
      },
    };
    const envErrs = validate(envelope, SCHEMA.definitions.handoff_envelope);
    ok('dispatcher handoff_envelope validates against schema', envErrs.length === 0);
    if (envErrs.length) console.log('   envelope errors:', envErrs);

    // CLAIM: hook-less worker self-registers on start_task. No /agent/start is EVER called, mirroring
    // a real run_in_background Agent-tool spawn (agent_tool_spawn never set → isSubagent false). The
    // claim carries the MAIN repo workspace (where overlay.git registration lives, so hasWorktree is
    // true) and is admitted ONLY because branch_task registered a worktree — the delegation proof.
    const claim = await req('POST', '/overlay/status', { key: K(1), status: 'in_progress', agent_id: 'rt-worker', session_id: SESSION, workspace: WS });
    ok('worker self-registers on hook-less claim (no SubagentStart hook)', claim.status === 200 && claim.body.ok === true);
    // A DIFFERENT agent cannot steal the in_progress claim without force — proves the claim bound the
    // worker as assignee end-to-end (the self-registration actually took effect).
    const steal = await req('POST', '/overlay/status', { key: K(1), status: 'in_progress', agent_id: 'other', session_id: SESSION, workspace: WS });
    ok('claim bound to the worker (different agent cannot steal without force)', steal.status === 409);

    // WRITE + COMMIT inside the worktree (the contract requires writes land on the attempt branch and
    // be committed before complete_task — an uncommitted worker makes merge_attempt a silent no-op).
    let committed = false, onAttemptBranch = false;
    if (worktreePath && fs.existsSync(worktreePath)) {
      fs.writeFileSync(path.join(worktreePath, 'result.txt'), 'handoff round-trip artifact\n');
      execFileSync('git', ['-C', worktreePath, 'add', '-A'], { stdio: 'ignore' });
      execFileSync('git', ['-C', worktreePath, 'commit', '-m', 'roundtrip: write result'], {
        stdio: 'ignore',
        env: { ...process.env, GIT_AUTHOR_NAME: 'rt', GIT_AUTHOR_EMAIL: 'rt@t', GIT_COMMITTER_NAME: 'rt', GIT_COMMITTER_EMAIL: 'rt@t' },
      });
      const head = execFileSync('git', ['-C', worktreePath, 'rev-parse', 'HEAD'], { encoding: 'utf8' }).trim();
      committed = /^[0-9a-f]{40}$/.test(head);
      onAttemptBranch = git.currentBranch(worktreePath) === wt.body.branch;
    }
    ok('worker write committed onto the attempt branch', committed && onAttemptBranch);

    // RETURN: the inbound task_result the worker reports for a non-metric task. No metric spec ⇒
    // has_metric_spec is false/absent ⇒ the conditional does NOT require metric_measurements, so a
    // result without measurements is valid.
    const result1 = {
      version: 1,
      status: 'tested',
      summary: 'roundtrip complete — wrote result.txt on the attempt branch',
      files_changed: ['result.txt'],
      tests_run: 'committed artifact on orch/attempt branch',
      decisions: [{ title: 'recorded roundtrip', wires_to: [K(1)] }],
    };
    const res1Errs = validate(result1, SCHEMA.definitions.task_result);
    ok('non-metric task_result validates (no measurements required)', res1Errs.length === 0);
    if (res1Errs.length) console.log('   result1 errors:', res1Errs);

    // COMPLETE: terminal write carrying the structured task_result. Accepted (the task has no metric
    // spec, so the handoff completeness gate does not fire).
    const done1 = await req('POST', '/overlay/status', { workspace: WS, key: K(1), status: 'tested', agent_id: 'rt-worker', session_id: SESSION, summary: result1.summary, task_result: result1 });
    ok('terminal complete_task with structured task_result accepted (200)', done1.status === 200 && done1.body.ok === true);

    // And the task actually landed `tested` end-to-end.
    const st = await req('GET', `/state?workspace=${encodeURIComponent(WS)}`);
    const tnode = st.body && Array.isArray(st.body.tasks) && st.body.tasks.find((t) => t.id === K(1));
    ok('task landed tested after the full round-trip', tnode && tnode.status === 'tested');

    // =================================================================================================
    // LEG B — the METRIC half of the contract on task 2: measure → schema metric-conditional →
    // terminal handoff gate. The gate fires on the terminal /overlay/status write and does not depend
    // on the claim workspace, so no claim is needed here.
    // =================================================================================================

    fs.writeFileSync(path.join(TASKS_DIR, '2.json'), JSON.stringify({ id: '2', subject: 'roundtrip metric handoff', status: 'pending' }));
    await req('GET', '/state');
    ok('root declared for metric task', (await req('POST', '/mark-root', { workspace: WS, task_key: K(2) })).status === 200);
    ok('metric spec set on task 2', (await req('POST', '/task/metric', { workspace: WS, key: K(2), spec: METRIC })).status === 200);

    // MEASURE: run the configured measure_command (echo 7) via measure_task.
    const meas = await req('POST', '/task/measure', { workspace: WS, key: K(2) });
    ok('metric measurement recorded', meas.status === 200);

    // The metric worker's task_result: has_metric_spec injected (T2's validation-time discriminator
    // from overlay.metrics[key]) makes the conditional require metric_measurements — it carries them.
    const result2 = {
      version: 1,
      status: 'tested',
      summary: 'roundtrip metric complete — measured score=7',
      files_changed: ['result.txt'],
      tests_run: 'node measure_task via daemon',
      decisions: [],
      metric_measurements: { value: 7 },
      has_metric_spec: true,
    };
    const res2Errs = validate(result2, SCHEMA.definitions.task_result);
    ok('metric task_result validates against schema (metric conditional satisfied)', res2Errs.length === 0);
    if (res2Errs.length) console.log('   result2 errors:', res2Errs);

    // COMPLETE: terminal write carrying the metric task_result. The daemon's handoff gate (T2) accepts
    // it because metric_measurements is present and non-empty.
    const { has_metric_spec, ...result2Wire } = result2; // discriminator is validation-time only, not persisted
    const done2 = await req('POST', '/overlay/status', { workspace: WS, key: K(2), status: 'tested', agent_id: 'rt-worker', summary: result2.summary, task_result: result2Wire });
    ok('terminal complete_task with metric task_result accepted by handoff gate (200)', done2.status === 200 && done2.body.ok === true);
  } finally {
    try { child.kill(); } catch { /* already gone */ }
    fs.rmSync(TASKS_DIR, { recursive: true, force: true });
    fs.rmSync(PROJ_DIR, { recursive: true, force: true });
    fs.rmSync(SANDBOX, { recursive: true, force: true });
    fs.rmSync(WS, { recursive: true, force: true });
  }
  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail === 0 ? 0 : 1);
})();
