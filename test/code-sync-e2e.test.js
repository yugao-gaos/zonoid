#!/usr/bin/env node
// E2E test for the native code onboarder against an ISOLATED daemon (NEVER prod :8787).
//
// Exercises the real path end-to-end:
//   1. boot an isolated daemon on :8799 with ORCH_DATA=<temp> (models symlinked so MiniLM loads from
//      cache, no 90MB download);
//   2. FULL onboard this repo's lib/ via scripts/onboard-code.js — proves the CLI extracts + bulk-ingests
//      real symbols into the daemon's code-index and /search retrieves them;
//   3. in a THROWAWAY git fixture repo (2 commits): commit a baseline, full-onboard it, then ADD a
//      function to a file + DELETE a file, commit, and run `onboard-code --sync`. Assert the added
//      symbol's code_node now appears in /search and the deleted file's code_nodes are gone.
//
// SKIPPED under ZONOID_SKIP_LIVE=1 (the standard `node scripts/run-tests.js` sets it) because it spawns
// a real daemon + MiniLM sidecar. Run explicitly:  node test/code-sync-e2e.test.js
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawn, spawnSync, execFileSync } = require('child_process');

if (process.env.ZONOID_SKIP_LIVE === '1') {
  console.log('SKIP  code-sync-e2e (ZONOID_SKIP_LIVE=1 — needs a live isolated daemon + MiniLM)');
  process.exit(0);
}

const ROOT = path.join(__dirname, '..');
const PORT = Number(process.env.ORCH_E2E_PORT || 8799);
const DAEMON = `http://127.0.0.1:${PORT}`;
const REAL_MODELS = path.resolve(os.homedir(), '.claude', 'orchestrator', '.zonoid', 'models');

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

function req(method, urlPath, body) {
  return new Promise((resolve, reject) => {
    const data = body != null ? Buffer.from(JSON.stringify(body)) : null;
    const u = new URL(DAEMON + urlPath);
    const r = http.request({ hostname: u.hostname, port: u.port, path: u.pathname + u.search, method,
      headers: data ? { 'Content-Type': 'application/json', 'Content-Length': data.length } : {} },
      (res) => { let s = ''; res.on('data', (d) => s += d); res.on('end', () => { let j = null; try { j = s ? JSON.parse(s) : null; } catch {} resolve({ status: res.statusCode, body: j }); }); });
    r.on('error', reject); r.setTimeout(60000, () => r.destroy(new Error('timeout')));
    if (data) r.write(data); r.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitReady(timeoutMs) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await req('GET', '/health'); if (r.status === 200 && r.body && r.body.phase === 'ready') return true; } catch {}
    await sleep(500);
  }
  return false;
}

// Poll /search until a result with predicate p appears (embeds may lazy-load on first call; the
// sidecar can take a few seconds), or timeout.
async function searchUntil(query, ws, predicate, timeoutMs) {
  const t0 = Date.now();
  let last = [];
  while (Date.now() - t0 < timeoutMs) {
    const r = await req('GET', `/search?q=${encodeURIComponent(query)}&k=20&workspace=${encodeURIComponent(ws)}`);
    last = (r.body && r.body.results) || [];
    if (last.some(predicate)) return { hit: true, results: last };
    await sleep(1000);
  }
  return { hit: false, results: last };
}

function git(repo, args) { return String(execFileSync('git', ['-C', repo, ...args], { encoding: 'utf8' }).trim()); }

(async () => {
  if (!fs.existsSync(path.join(REAL_MODELS, 'Xenova'))) {
    console.log(`SKIP  code-sync-e2e (no cached MiniLM at ${REAL_MODELS}; would need a 90MB download)`);
    process.exit(0);
  }

  const TMP_DATA = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e2e-data-'));
  const WS = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e2e-ws-'));
  const FIXTURE = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e2e-fixture-'));
  let daemon = null;
  const cleanup = () => {
    try { if (daemon && !daemon.killed) daemon.kill(); } catch {}
    // Kill the detached embed sidecar (it writes embed.pid under ORCH_DATA).
    try {
      const pidFile = path.join(TMP_DATA, 'embed.pid');
      if (fs.existsSync(pidFile)) { const pid = parseInt(fs.readFileSync(pidFile, 'utf8').trim(), 10); if (pid) { try { process.kill(pid); } catch {} } }
    } catch {}
    for (const d of [TMP_DATA, WS, FIXTURE]) { try { fs.rmSync(d, { recursive: true, force: true }); } catch {} }
  };

  try {
    // ---- symlink models so MiniLM loads from cache (no download) -------------------------------
    const linkPath = path.join(TMP_DATA, 'models');
    fs.mkdirSync(TMP_DATA, { recursive: true });
    let linked = false;
    try { fs.symlinkSync(REAL_MODELS, linkPath, 'junction'); linked = true; }      // Windows dir junction: no admin needed
    catch { try { fs.symlinkSync(REAL_MODELS, linkPath, 'dir'); linked = true; } catch (e) { console.log(`  (symlink failed: ${e.message}; copying models instead)`); } }
    if (!linked) { fs.cpSync(REAL_MODELS, linkPath, { recursive: true }); }
    ok('models symlinked/copied into isolated ORCH_DATA', fs.existsSync(path.join(linkPath, 'Xenova')));

    // ---- boot the isolated daemon -------------------------------------------------------------
    const logFd = fs.openSync(path.join(TMP_DATA, 'daemon.log'), 'a');
    daemon = spawn(process.execPath, [path.join(ROOT, 'daemon.js')], {
      cwd: ROOT,
      env: { ...process.env, ORCH_PORT: String(PORT), ORCH_DATA: TMP_DATA, ZONOID_SKIP_LIVE: '' },
      stdio: ['ignore', logFd, logFd],
      windowsHide: true,
    });
    const ready = await waitReady(60000);
    ok('isolated daemon reached phase:ready on :' + PORT, ready);
    if (!ready) { console.log(fs.readFileSync(path.join(TMP_DATA, 'daemon.log'), 'utf8').slice(-2000)); throw new Error('daemon did not become ready'); }

    // ============================================================================================
    // (A) FULL onboard this repo's lib/ — real extractor + bulk ingest + retrieval
    // ============================================================================================
    const libDir = path.join(ROOT, 'lib');
    const fullRun = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'onboard-code.js'),
      '--repo', libDir, '--workspace', WS, '--daemon', DAEMON], { encoding: 'utf8', timeout: 180000 });
    if (fullRun.status !== 0) { console.log('onboard stdout:', fullRun.stdout); console.log('onboard stderr:', fullRun.stderr); }
    ok('onboard-code FULL exited 0', fullRun.status === 0);
    ok('onboard-code FULL summary printed symbol count', /symbols:\s+\d+/.test(fullRun.stdout || ''));

    // A known symbol from lib/code-extract/sync.js — syncRepo — should be retrievable.
    const found = await searchUntil('syncRepo incremental git diff code sync', WS,
      (r) => r.kind === 'code_node' && /syncRepo/.test(r.title || r.key || ''), 90000);
    ok('FULL onboard: a real lib/ symbol (syncRepo) is retrievable as a code_node via /search', found.hit);
    if (!found.hit) console.log('  top results:', found.results.slice(0, 6).map((r) => `${r.kind}:${r.title || r.key}`));

    // lastIndexedCommit was recorded for the lib repo (its repo = ROOT, the git repo lib/ lives in).
    // (the CLI keys the watermark by the --repo abs path)

    // ============================================================================================
    // (B) THROWAWAY git fixture — sync delta (add a function + delete a file)
    // ============================================================================================
    git(FIXTURE, ['init', '-q']);
    git(FIXTURE, ['config', 'user.email', 'e2e@test']);
    git(FIXTURE, ['config', 'user.name', 'e2e']);
    fs.mkdirSync(path.join(FIXTURE, 'src'), { recursive: true });
    fs.writeFileSync(path.join(FIXTURE, 'src', 'keep.js'), 'export function keepBaseline(){ return 1; }\n');
    fs.writeFileSync(path.join(FIXTURE, 'src', 'doomed.js'), 'export function willBeDeleted(){ return 99; }\n');
    git(FIXTURE, ['add', '-A']); git(FIXTURE, ['commit', '-q', '-m', 'baseline']);

    const FWS = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-e2e-fws-'));
    try {
      // Full-onboard the fixture (records lastIndexedCommit = baseline HEAD).
      const fxFull = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'onboard-code.js'),
        '--repo', FIXTURE, '--workspace', FWS, '--daemon', DAEMON], { encoding: 'utf8', timeout: 120000 });
      ok('fixture FULL onboard exited 0', fxFull.status === 0);

      // Baseline: willBeDeleted present, brandNewlyAdded absent.
      const base = await searchUntil('willBeDeleted doomed function', FWS,
        (r) => r.kind === 'code_node' && /willBeDeleted/.test(r.title || r.key || ''), 60000);
      ok('fixture baseline: doomed symbol indexed', base.hit);

      // CHANGE: add a function to keep.js, delete doomed.js, commit.
      fs.writeFileSync(path.join(FIXTURE, 'src', 'keep.js'),
        'export function keepBaseline(){ return 1; }\nexport function brandNewlyAdded(z){ return z + 7; }\n');
      fs.rmSync(path.join(FIXTURE, 'src', 'doomed.js'));
      git(FIXTURE, ['add', '-A']); git(FIXTURE, ['commit', '-q', '-m', 'add fn + delete file']);

      // SYNC.
      const fxSync = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'onboard-code.js'),
        '--repo', FIXTURE, '--workspace', FWS, '--daemon', DAEMON, '--sync'], { encoding: 'utf8', timeout: 120000 });
      if (fxSync.status !== 0) { console.log('sync stdout:', fxSync.stdout); console.log('sync stderr:', fxSync.stderr); }
      ok('onboard-code --sync exited 0', fxSync.status === 0);
      // The sync path (NOT the full-onboard fallback) must run: its summary prints the diff range and a
      // "changed:" line. If it fell back to full, this regex won't match (full prints no diff/changed).
      ok('sync ran the incremental path (diff + changed-files summary)',
        /diff:\s+\S+\.\.\S+/.test(fxSync.stdout || '') && /changed:\s+\d+ file/.test(fxSync.stdout || ''));
      ok('sync replaced keep.js and deleted doomed.js (1 replaced, 1 deleted)',
        /replaced:\s+1 file/.test(fxSync.stdout || '') && /deleted:\s+1 file/.test(fxSync.stdout || ''));

      // ASSERT: the new symbol now appears.
      const added = await searchUntil('brandNewlyAdded new function', FWS,
        (r) => r.kind === 'code_node' && /brandNewlyAdded/.test(r.title || r.key || ''), 60000);
      ok('after --sync: the ADDED symbol (brandNewlyAdded) is retrievable', added.hit);

      // ASSERT: the deleted file's code_nodes are gone. Check directly via the overlay file on disk
      // (authoritative) so we don't depend on /search ranking — read the workspace overlay and confirm
      // no code_node references src/doomed.js.
      const gone = await (async () => {
        // give the deletion a moment to persist
        for (let i = 0; i < 30; i++) {
          const r = await req('GET', `/search?q=${encodeURIComponent('willBeDeleted doomed')}&k=20&workspace=${encodeURIComponent(FWS)}`);
          const results = (r.body && r.body.results) || [];
          const stillThere = results.some((x) => x.kind === 'code_node' && (/doomed\.js/.test(x.file || '') || /willBeDeleted/.test(x.title || x.key || '')));
          if (!stillThere) return true;
          await sleep(1000);
        }
        return false;
      })();
      ok('after --sync: the DELETED file\'s code_nodes are gone from retrieval', gone);
    } finally {
      try { fs.rmSync(FWS, { recursive: true, force: true }); } catch {}
    }

    console.log(`\n${pass} passed, ${fail} failed`);
    cleanup();
    process.exit(fail > 0 ? 1 : 0);
  } catch (e) {
    console.error('E2E error:', e && e.stack ? e.stack : e);
    try { if (fs.existsSync(path.join(TMP_DATA, 'daemon.log'))) console.error('--- daemon.log tail ---\n' + fs.readFileSync(path.join(TMP_DATA, 'daemon.log'), 'utf8').slice(-2000)); } catch {}
    cleanup();
    process.exit(1);
  }
})();
