#!/usr/bin/env node
// Smoke tests for scripts/bench-e2e.js — dry-run only (no Claude, no live daemon by default).
//
// Run: node test/bench-e2e.test.js
// Live graph-seed smoke: unset ZONOID_SKIP_LIVE
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn } = require('child_process');

const REPO = path.join(__dirname, '..');
const bench = require(path.join(REPO, 'scripts', 'bench-e2e'));

let pass = 0, fail = 0, skip = 0;
const ok = (label, cond) => { if (cond) { console.log('PASS  ' + label); pass++; } else { console.log('FAIL  ' + label); fail++; } };
const skipped = (label, why) => { console.log('SKIP  ' + label + ' (' + why + ')'); skip++; };

function httpJson(port, method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({
      host: '127.0.0.1', port, path: urlPath, method,
      headers: data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {},
      timeout: 8000,
    }, (res) => {
      let s = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { s += c; });
      res.on('end', () => {
        try { resolve({ status: res.statusCode, body: s ? JSON.parse(s) : {} }); }
        catch { resolve({ status: res.statusCode, body: {} }); }
      });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    if (data) req.write(data);
    req.end();
  });
}

(async () => {
  // ── module surface ─────────────────────────────────────────────────────────
  ok('loadScenario is a function', typeof bench.loadScenario === 'function');
  ok('runDryRun is a function', typeof bench.runDryRun === 'function');
  ok('runGrader is a function', typeof bench.runGrader === 'function');

  // ── scenario load ──────────────────────────────────────────────────────────
  let scenario;
  try {
    scenario = bench.loadScenario('dag-chain');
    ok('dag-chain scenario loads', scenario.id === 'dag-chain');
    ok('dag-chain has secret', typeof scenario.secret === 'string' && scenario.secret.length > 0);
    ok('dag-chain grader file exists', fs.existsSync(path.join(scenario.dir, scenario.grader)));
  } catch (e) {
    ok('dag-chain scenario loads', false);
    console.log('      ' + e.message);
  }

  if (scenario) {
    // ── grader ───────────────────────────────────────────────────────────────
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-e2e-test-'));
    const bad = path.join(tmp, 'bad.txt');
    const good = path.join(tmp, 'good.txt');
    fs.writeFileSync(bad, 'UNKNOWN\n');
    fs.writeFileSync(good, scenario.secret + '\n');

    const gBad = bench.runGrader(scenario.dir, scenario.grader, bad, scenario.secret);
    const gGood = bench.runGrader(scenario.dir, scenario.grader, good, scenario.secret);
    ok('grader rejects missing secret', gBad.ok === false && gBad.secretFound === false);
    ok('grader accepts correct secret', gGood.ok === true && gGood.secretFound === true);

    // ── dry-run comparison ───────────────────────────────────────────────────
    const cmp = await bench.runDryRun(scenario, scenario.dir);
    ok('dry-run OFF fails', cmp.off.passed === false);
    ok('dry-run ON passes', cmp.on.passed === true);
    ok('dry-run dagRequired', cmp.dagRequired === true);

    // ── buildTaskBPrompt: secret must not appear in Task B prompt ──────────────
    const offPrompt = bench.buildTaskBPrompt(scenario, scenario.dir, 'bench-test/2', 'off');
    const onPrompt  = bench.buildTaskBPrompt(scenario, scenario.dir, 'bench-test/2', 'on');
    ok('buildTaskBPrompt OFF: secret absent from prompt', !offPrompt.includes(scenario.secret));
    ok('buildTaskBPrompt ON: secret absent from prompt',  !onPrompt.includes(scenario.secret));
    ok('buildTaskBPrompt ON: preamble includes get_dependency_summaries', onPrompt.includes('get_dependency_summaries'));

    // ── CLI dry-run subprocess ───────────────────────────────────────────────
    const cli = spawn(process.execPath, [path.join(REPO, 'scripts', 'bench-e2e.js'), '--scenario', 'dag-chain', '--dry-run'], {
      cwd: REPO, encoding: 'utf8',
    });
    let cliOut = '';
    cli.stdout.on('data', (c) => { cliOut += c; });
    await new Promise((r) => cli.on('close', r));
    let cliRow = null;
    try { cliRow = JSON.parse(cliOut.trim().split('\n').pop()); } catch { /* */ }
    ok('CLI --dry-run exits 0', cli.exitCode === 0);
    ok('CLI --dry-run reports dagRequired', cliRow && cliRow.dagRequired === true);
  }

  // ── live graph seed (optional) ─────────────────────────────────────────────
  if (process.env.ZONOID_SKIP_LIVE === '1') {
    skipped('live seedGraphOnArm exposes Task A summary to B', 'ZONOID_SKIP_LIVE=1');
  } else if (!scenario) {
    skipped('live seedGraphOnArm', 'no scenario');
  } else {
    const SANDBOX = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-e2e-live-'));
    const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'bench-e2e-ws-'));
    const PORT = 8830 + Math.floor(Math.random() * 50);
    const session = 'bench-e2e-test-' + Date.now();
    let fixtures = null;
    const child = spawn(process.execPath, [path.join(REPO, 'daemon.js')], {
      env: { ...process.env, ORCH_PORT: String(PORT), CLAUDE_PLUGIN_DATA: SANDBOX },
      stdio: 'ignore',
    });
    try {
      for (let i = 0; i < 80; i++) {
        try { const p = await httpJson(PORT, 'GET', '/ping'); if (p.status === 200) break; } catch { /* */ }
        await new Promise((r) => setTimeout(r, 100));
      }
      fixtures = bench.writeNativeFixtures(WS, session, scenario);
      const seeded = await bench.seedGraphOnArm({
        port: PORT, workspace: WS, scenario,
        keyA: fixtures.keyA, keyB: fixtures.keyB,
      });
      const summaries = seeded.ctx?.summaries || seeded.ctx?.deps || [];
      const hasSecret = JSON.stringify(seeded.ctx).includes(scenario.secret);
      ok('seedGraph: context includes secret', hasSecret);
      ok('seedGraph: task A summary template applied', seeded.summary.includes(scenario.secret));
    } finally {
      if (fixtures) bench.cleanupNativeFixtures({ ...fixtures, session });
      try { child.kill('SIGKILL'); } catch { /* */ }
      try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* */ }
      try { fs.rmSync(WS, { recursive: true, force: true }); } catch { /* */ }
    }
  }

  console.log('-----');
  console.log(pass + ' passed, ' + fail + ' failed, ' + skip + ' skipped');
  process.exit(fail === 0 ? 0 : 1);
})();
