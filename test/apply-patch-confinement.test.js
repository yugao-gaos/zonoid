#!/usr/bin/env node
// E2E: the write-gate confines a CLAIMED worker's apply_patch (Codex) edits to its attempt worktree.
//
// Codex's apply_patch tool does NOT populate tool_input.file_path — the target path(s) live inside
// the patch body (`*** Add/Update/Delete File: <path>`, `*** Move to: <path>`). Before the fix the
// gate read only file_path, so a claimed Codex worker's apply_patch targets were never confine-
// checked: it could patch files OUTSIDE its worktree undetected. This test stands up a real claimed
// worktree (same recipe as self-register-on-claim.test.js) and drives the ACTUAL hooks/orch-gate.js
// with apply_patch payloads, asserting:
//   - in-worktree path  → exit 0 (allow)
//   - out-of-worktree   → exit 2 (deny, confinement reason)
//   - multi-file, one outside → exit 2 (any-outside blocks)
//   - relative in-worktree path (resolved against the worktree cwd) → exit 0
// The .sh core is behaviorally identical (enforced dual-track); it is exercised too when bash is on
// PATH, otherwise that leg is skipped (the e2e harness convention is to drive the .js ports).
// Run: node test/apply-patch-confinement.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync } = require('child_process');
const git = require('../lib/git');

const SANDBOX = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-applypatch-base-')));
process.env.CLAUDE_PLUGIN_DATA = SANDBOX;
const PORT = 19370 + Math.floor(Math.random() * 200);
const WS = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'orch-applypatch-ws-')));

const SESSION = 'aaaaaaaa-feedface-0000-4000-800000000004';
const { encodeWorkspace } = require('../lib/native-tasks');
const PROJ_DIR = path.join(os.homedir(), '.claude', 'projects', encodeWorkspace(WS));
const TASKS_DIR = path.join(os.homedir(), '.claude', 'tasks', SESSION);
const K = (id) => `${SESSION}/${id}`;
const HOOKS = path.join(__dirname, '..', 'hooks');

let pass = 0, fail = 0;
const ok = (label, cond, detail) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}${detail ? '  — ' + detail : ''}`); fail++; }
};

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

// Build a Codex apply_patch envelope touching the given paths under tool_input.input.
function patchEnvelope(paths, field = 'input') {
  const body = ['*** Begin Patch'];
  for (const p of paths) {
    body.push(`*** Update File: ${p}`);
    body.push('@@');
    body.push('-old line');
    body.push('+new line');
  }
  body.push('*** End Patch');
  return { tool_name: 'apply_patch', session_id: SESSION, tool_input: { [field]: body.join('\n') } };
}

// Spawn env for the gate: point at the sandbox daemon and CLEAR ORCH_GATE_OFF (the worker/bench
// harness sets it to ungate worker sessions — if it leaks into the child the gate no-ops and the
// confinement check never runs, masking this very test).
function gateEnv() {
  const e = { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) };
  delete e.ORCH_GATE_OFF;
  return e;
}
function runGateJs(payload) {
  const res = spawnSync(process.execPath, [path.join(HOOKS, 'orch-gate.js')], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 8000, env: gateEnv(),
  });
  return { code: res.status, stderr: (res.stderr || '').trim() };
}

function bashAvailable() {
  try { return spawnSync('bash', ['-c', 'command -v jq >/dev/null && command -v curl >/dev/null'], { timeout: 5000 }).status === 0; }
  catch { return false; }
}
function runGateSh(payload) {
  const res = spawnSync('bash', [path.join(HOOKS, 'orch-gate.sh')], {
    input: JSON.stringify(payload), encoding: 'utf8', timeout: 8000, env: gateEnv(),
  });
  return { code: res.status, stderr: (res.stderr || '').trim() };
}

(async () => {
  git.initRepo(WS);
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  fs.writeFileSync(path.join(PROJ_DIR, `${SESSION}.jsonl`), '');
  fs.mkdirSync(TASKS_DIR, { recursive: true });
  fs.writeFileSync(path.join(TASKS_DIR, '1.json'), JSON.stringify({ id: '1', subject: 'apply_patch confinement alpha', status: 'pending' }));

  const child = spawn(process.execPath, [path.join(__dirname, '..', 'daemon.js')], {
    env: { ...process.env, CLAUDE_PLUGIN_DATA: SANDBOX, ORCH_PORT: String(PORT) },
    stdio: 'ignore',
  });
  try {
    ok('daemon came up', await waitForPing());
    ok('workspace pinned', (await req('POST', '/workspace', { path: WS })).status === 200);
    await req('GET', '/state');
    ok('root declared', (await req('POST', '/mark-root', { task_key: K(1), workspace: WS })).status === 200);

    // Branch an attempt worktree (registers it in overlay.git) then self-register-on-claim.
    // P3: no daemon-global workspace — repo resolution requires an explicit workspace per request.
    const wt = await req('POST', '/git/worktree', { key: K(1), workspace: WS });
    ok('attempt worktree created', wt.status === 200 && String(wt.body.branch).startsWith('orch/attempt/'));
    const WT = fs.realpathSync(wt.body.worktree);
    const claim = await req('POST', '/overlay/status', { key: K(1), status: 'in_progress', agent_id: 'cdx-worker', session_id: SESSION, workspace: WS });
    ok('claim succeeds (worker owns task)', claim.status === 200 && claim.body.ok === true);

    // Sanity: the daemon now reports this session claimed with a registered worktree path.
    const ac = await req('GET', `/active-claim?session=${encodeURIComponent(SESSION)}`);
    ok('active-claim reports claimed', ac.body && ac.body.claimed === true, JSON.stringify(ac.body).slice(0, 120));

    const inside = path.join(WT, 'src', 'app.js');
    const outside = path.join(WS, 'sneaky.js');   // main repo, NOT the attempt worktree

    // ── .js core (Claude runs this; the e2e harness drives the .js ports) ──────
    {
      const r = runGateJs(patchEnvelope([inside]));
      ok('JS: apply_patch INSIDE worktree allowed (exit 0)', r.code === 0, `code=${r.code} ${r.stderr}`);
    }
    {
      const r = runGateJs(patchEnvelope([outside]));
      ok('JS: apply_patch OUTSIDE worktree denied (exit 2)', r.code === 2, `code=${r.code}`);
      ok('JS: deny carries confinement reason', /registered worktree/.test(r.stderr) && r.stderr.includes('sneaky.js'), r.stderr);
    }
    {
      const r = runGateJs(patchEnvelope([inside, outside]));   // multi-file: one outside ⇒ block
      ok('JS: multi-file apply_patch with one OUTSIDE denied (exit 2)', r.code === 2, `code=${r.code}`);
    }
    {
      // Relative target (apply_patch headers are often workspace-relative) resolves against the
      // worktree cwd ⇒ inside ⇒ allowed.
      const r = runGateJs(patchEnvelope(['src/app.js']));
      ok('JS: relative in-worktree apply_patch allowed (exit 0)', r.code === 0, `code=${r.code} ${r.stderr}`);
    }
    {
      // Field-name robustness: same patch under tool_input.patch instead of .input.
      const r = runGateJs(patchEnvelope([outside], 'patch'));
      ok('JS: apply_patch under .patch field still confine-checked (exit 2)', r.code === 2, `code=${r.code}`);
    }

    // ── .sh core (enforced dual-track) ─────────────────────────────────────────
    // The .sh is the POSIX track (Codex/Cursor/CI run it; Claude runs the .js). It prefix-matches
    // paths with raw bash `case` and does NOT slash-normalize the daemon worktree, so on win32 —
    // where the daemon returns BACKSLASH worktree paths but apply_patch headers are forward-slash —
    // the in-worktree/relative comparisons can't reconcile separators. That is a Windows-only
    // harness artifact; the .js leg above fully covers Windows. So: run the full INSIDE/relative
    // E2E only on POSIX, but assert the OUTSIDE-deny on EVERY bash host using an absolute POSIX
    // target (`/etc/passwd`) that is unambiguously outside a C:\… or /…/worktree regardless of
    // separator — this exercises the REAL orch-gate.sh extraction + confinement + exit-2 deny.
    if (bashAvailable()) {
      const rAbs = runGateSh(patchEnvelope(['/etc/passwd']));
      ok('SH: apply_patch to absolute OUTSIDE path denied (exit 2)', rAbs.code === 2, `code=${rAbs.code}`);
      ok('SH: deny carries confinement reason', /registered worktree/.test(rAbs.stderr), rAbs.stderr.slice(0, 120));
      const rMulti = runGateSh(patchEnvelope(['/etc/passwd', 'src/app.js']));
      ok('SH: multi-file apply_patch with one absolute OUTSIDE denied (exit 2)', rMulti.code === 2, `code=${rMulti.code}`);
      if (process.platform !== 'win32') {
        ok('SH: apply_patch INSIDE worktree allowed (exit 0)', runGateSh(patchEnvelope([inside])).code === 0);
        const rOut = runGateSh(patchEnvelope([outside]));
        ok('SH: apply_patch OUTSIDE (sibling repo) denied (exit 2)', rOut.code === 2, `code=${rOut.code}`);
        ok('SH: relative in-worktree apply_patch allowed (exit 0)', runGateSh(patchEnvelope(['src/app.js'])).code === 0);
      } else {
        console.log('SKIP  SH INSIDE/relative E2E (win32 path-separator skew; JS leg covers Windows)');
      }
    } else {
      console.log('SKIP  SH core (bash/jq/curl not on PATH)');
    }
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
