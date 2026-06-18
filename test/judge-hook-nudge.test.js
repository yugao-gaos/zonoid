#!/usr/bin/env node
// Tests for the judge nudge relayed by hooks/classify.sh via POST /classify.
// Strategy: pipe a synthetic prompt JSON into classify.sh with a stub curl on PATH that
// returns a controlled /classify response. Verify the nudge line appears when present in
// additional_context, is absent when omitted, and is absent when ORCH_GATE_OFF=1.
//
// Pattern mirrors test/orch-gate-bash.test.js: spawnSync the hook, inject stub curl.
// Run: node test/judge-hook-nudge.test.js — exits non-zero on any failed assertion.
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const { HEARTBEAT } = require('../lib/classify-assemble');
const { writeCurlStub, hookEnv } = require('./helpers/curl-stub');

const HOOK = path.resolve(__dirname, '..', 'hooks', 'classify.sh');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'judge-hook-nudge-test-'));

let pass = 0, fail = 0;
function ok(label, cond) {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else       { console.log(`FAIL  ${label}`); fail++; }
}

// Build a synthetic UserPromptSubmit input JSON
function mkInput(prompt, sessionId) {
  return JSON.stringify({ prompt: prompt || 'hello world', session_id: sessionId || 'test-nudge-sid' });
}

// Run the hook with the given input and env overrides; returns { status, stdout, stderr }.
// The stub dir rides in extraEnv.PATH as `${stubDir}:${process.env.PATH}`; we split off the
// leading stub dir and rebuild the PATH through hookEnv so `jq` stays resolvable in the spawned
// bash on Windows (see test/helpers/curl-stub.js for the full rationale).
function runHook(input, extraEnv = {}) {
  const { PATH: rawPath, ...rest } = extraEnv;
  let stubDirs = [];
  let envOverrides = rest;
  if (rawPath) {
    const tail = ':' + process.env.PATH;
    stubDirs = rawPath.endsWith(tail) ? [rawPath.slice(0, -tail.length)] : [rawPath];
  } else {
    envOverrides = { ...rest, PATH: process.env.PATH };
  }
  const env = hookEnv(stubDirs, envOverrides);
  const r = spawnSync('bash', [HOOK], { input, encoding: 'utf8', env });
  return { status: r.status, stdout: r.stdout || '', stderr: r.stderr || '' };
}

const BASE_CTX = `[Model routing] Recommended: main=claude-sonnet-4-6, subagent=claude-opus-4-8 (fast) (complexity=0.2, gate=abstain)
[Orch gate] Claim only the task matching the work at hand — NEVER force-claim a task to unlock edits for unrelated work; create a new task instead. Force-claims are capped at 3 per task; over cap requires user approval on the dashboard.
${HEARTBEAT}`;

ok('BASE_CTX heartbeat matches classify HEARTBEAT constant', BASE_CTX.includes(HEARTBEAT));

const JUDGE_NUDGE = `[Judge] backlog: 35 items (3 dup-clusters) — dispatch ONE background self-learn-edge-judge subagent (model: sonnet — NOT haiku, verdict discrimination degrades; budget 20) this turn; do not block the user's request on it. The subagent MUST: (1) call mcp__orchestrator-graph__start_task with task_key="followup/harness-judge-drain" and agent_id="judge-drain-deadbeef" BEFORE judging; (2) call mcp__orchestrator-graph__complete_task with the same task_key and agent_id, and a summary including the count of items judged, AFTER finishing.`;

function mkClassifyStub(mode) {
  const dir = path.join(TMP, `stub-${mode}`);
  fs.mkdirSync(dir, { recursive: true });
  const ctxWithJudge = `${BASE_CTX}\n${JUDGE_NUDGE}`;
  const ctxNoJudge = BASE_CTX;
  fs.writeFileSync(path.join(dir, 'with-judge.json'), JSON.stringify({ additional_context: ctxWithJudge }));
  fs.writeFileSync(path.join(dir, 'no-judge.json'), JSON.stringify({ additional_context: ctxNoJudge }));
  writeCurlStub(
    dir,
    `DIR="$(cd "$(dirname "$0")" && pwd)"
ARGS="$*"
if printf "%s" "$ARGS" | grep -q "/classify"; then
  if [ "\${ORCH_GATE_OFF:-0}" = "1" ]; then
    cat "$DIR/no-judge.json"
  elif [ "${mode}" = "nudge-true" ]; then
    cat "$DIR/with-judge.json"
  else
    cat "$DIR/no-judge.json"
  fi
else
  echo '{}'
fi
exit 0
`,
  );
  return dir;
}

const stubNudgeDir = mkClassifyStub('nudge-true');
const stubNudgeFalseDir = mkClassifyStub('nudge-false');

// ── Stub curl that times out / returns nothing for classify (fail-silent test) ────────────────
const stubNoResponseDir = path.join(TMP, 'stub-no-response');
writeCurlStub(
  stubNoResponseDir,
  `ARGS="$*"
if printf "%s" "$ARGS" | grep -q "/classify"; then
  exit 1
else
  echo '{}'
fi
exit 0
`,
);

// Helper: parse additionalContext from hook stdout JSON
function extractCtx(stdout) {
  try {
    const obj = JSON.parse(stdout);
    return obj.hookSpecificOutput && obj.hookSpecificOutput.additionalContext || '';
  } catch {
    return '';
  }
}

// ── Test 1: nudge:true → nudge line appears in additionalContext with claim instruction ─────────
{
  const r = runHook(mkInput('hello world'), {
    PATH: stubNudgeDir + ':' + process.env.PATH,
    ORCH_GATE_OFF: '',   // explicitly unset
  });
  const ctx = extractCtx(r.stdout);
  ok('nudge:true → hook output contains [Judge] line', ctx.includes('[Judge]'));
  ok('nudge:true → line contains "backlog"', ctx.includes('backlog'));
  ok('nudge:true → depth 35 present', ctx.includes('35'));
  ok('nudge:true → dupClusters 3 present', ctx.includes('3 dup-cluster'));
  ok('nudge:true → dispatch instruction present', ctx.includes('self-learn-edge-judge'));
  // Model pin: judge verdicts degrade to rubber-stamp keeps on haiku (user decision 2026-06-12)
  ok('nudge:true → sonnet model pin present', ctx.includes('model: sonnet'));
  // Claim instruction: subagent must call start_task and complete_task with harness task key
  ok('nudge:true → start_task claim instruction present', ctx.includes('start_task'));
  ok('nudge:true → harness task key in nudge text', ctx.includes('followup/harness-judge-drain'));
  ok('nudge:true → complete_task instruction present', ctx.includes('complete_task'));
  ok('nudge:true → agent_id prefix "judge-drain-" present', ctx.includes('judge-drain-'));
}

// ── Test 2: nudge:false → nudge line ABSENT ───────────────────────────────────────────────────
{
  const r = runHook(mkInput('hello world'), {
    PATH: stubNudgeFalseDir + ':' + process.env.PATH,
    ORCH_GATE_OFF: '',
  });
  const ctx = extractCtx(r.stdout);
  ok('nudge:false → [Judge] line absent', !ctx.includes('[Judge]'));
}

// ── Test 3: ORCH_GATE_OFF=1 → nudge line absent (bench sandbox protection) ───────────────────
{
  // Use the nudge:true stub — but ORCH_GATE_OFF=1 must suppress the nudge entirely.
  const r = runHook(mkInput('hello world'), {
    PATH: stubNudgeDir + ':' + process.env.PATH,
    ORCH_GATE_OFF: '1',
  });
  const ctx = extractCtx(r.stdout);
  ok('ORCH_GATE_OFF=1 → [Judge] line absent even with nudge:true stub', !ctx.includes('[Judge]'));
  // The hook should still produce its other output (heartbeat, model routing, etc.)
  ok('ORCH_GATE_OFF=1 → hook still outputs other context (heartbeat)', ctx.includes('[Orchestrator heartbeat]'));
}

// ── Test 4: curl fails (no response) → fail-silent, no [Judge] line ──────────────────────────
{
  const r = runHook(mkInput('hello world'), {
    PATH: stubNoResponseDir + ':' + process.env.PATH,
    ORCH_GATE_OFF: '',
  });
  const ctx = extractCtx(r.stdout);
  ok('curl error → fail-silent: [Judge] line absent', !ctx.includes('[Judge]'));
  ok('curl error → hook still exits 0', r.status === 0);
  ok('curl error → no hook output', ctx === '');
}

// ── Cleanup ───────────────────────────────────────────────────────────────────────────────────
fs.rmSync(TMP, { recursive: true, force: true });

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
