#!/usr/bin/env node
// Always-on daemon logging (lib/daemon-log.js) + the observability endpoints it feeds:
// GET /version (routes/meta.js) and the extended GET /status (routes/activity.js).
//
// Covers:
//   TEE / ROTATION (all against a temp dir — never the real runtime dir)
//   (1) tee appends stamped lines to the configured file
//   (2) split lines (one logical line across several write chunks) are stamped exactly once
//   (3) rotation triggers at the size cap: live file resets, .1 holds the old bytes
//   (4) generations cap: 3 files total (live, .1, .2) — a .3 is never created
//   (5) resolvePath contract: OFF kills it, explicit ORCH_DAEMON_LOG wins (also under
//       ZONOID_SKIP_LIVE), bare ZONOID_SKIP_LIVE disables the implicit runtime default
//   (6) install() in a REAL child process tees console.log + console.error to the file
//       while the original streams still work
//   ROUTES (driven directly with a fake ctx — no port binding)
//   (7) GET /version keeps the legacy load-bearing fields (head/bootedAt/features) and adds
//       version/node/pid/uptime_s/log_path
//   (8) GET /status carries the new observability fields: governor, running_by_kind,
//       loops_active, log_path, lanes
//
// Run: node test/daemon-log.test.js
'use strict';

let pass = 0, fail = 0;
const ok = (label, cond) => { if (cond) { console.log(`PASS  ${label}`); pass++; } else { console.log(`FAIL  ${label}`); fail++; } };

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawnSync } = require('child_process');

// Redirect the activity archive BEFORE requiring lib/activity (via routes/activity) — /status
// counts merges_today from the persisted archive and must not read or write the real one.
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'daemon-log-test-'));
process.env.ORCH_ACTIVITY_LOG = path.join(TMP, 'activity.jsonl');

const daemonLog = require('../lib/daemon-log');

const LOG = path.join(TMP, 'daemon.log');
const read = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const clearLogs = () => {
  for (const f of [LOG, `${LOG}.1`, `${LOG}.2`, `${LOG}.3`]) { try { fs.unlinkSync(f); } catch { /* absent */ } }
};

const ISO_LINE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[(OUT|ERR)\] /;

// ---- (1) stamped append -----------------------------------------------------------------
{
  clearLogs();
  daemonLog._resetForTests();
  daemonLog.configure({ ORCH_DAEMON_LOG: LOG });
  daemonLog._tee('out', 'hello from stdout\n');
  daemonLog._tee('err', 'boom from stderr\n');
  const text = read(LOG);
  const lines = text.trim().split('\n');
  ok('tee appends both streams', lines.length === 2);
  ok('stdout line is stamped [OUT]', ISO_LINE.test(lines[0]) && /\[OUT\] hello from stdout/.test(lines[0]));
  ok('stderr line is stamped [ERR]', /\[ERR\] boom from stderr/.test(lines[1]));
}

// ---- (2) split lines stamped once ---------------------------------------------------------
{
  clearLogs();
  daemonLog._resetForTests();
  daemonLog.configure({ ORCH_DAEMON_LOG: LOG });
  daemonLog._tee('out', 'part one, ');
  daemonLog._tee('out', 'part two\nnext line\n');
  const lines = read(LOG).trim().split('\n');
  ok('split line lands as ONE log line', lines.length === 2);
  ok('split line stamped exactly once', ISO_LINE.test(lines[0])
    && /part one, part two$/.test(lines[0])
    && !/\[OUT\].*\[OUT\]/.test(lines[0]));
  ok('following line gets its own stamp', ISO_LINE.test(lines[1]) && /next line$/.test(lines[1]));
}

// ---- (3) rotation at the size cap ----------------------------------------------------------
{
  clearLogs();
  daemonLog._resetForTests();
  daemonLog.configure({ ORCH_DAEMON_LOG: LOG });
  process.env.ORCH_DAEMON_LOG_MAX_BYTES = '200';
  daemonLog._tee('out', `${'a'.repeat(300)}\n`);   // first write: no rotation (file was empty)
  const preRotate = fs.statSync(LOG).size;
  daemonLog._tee('out', 'after rotation\n');        // file >= cap now → rotate first, then append
  ok('live file was over the cap before rotating', preRotate >= 200);
  ok('rotation moved the old bytes to .1', /a{300}/.test(read(`${LOG}.1`) || ''));
  ok('live file restarts with only the new line', /after rotation/.test(read(LOG)) && !/a{300}/.test(read(LOG)));
  ok('post-rotation line is stamped at line start', ISO_LINE.test(read(LOG)));
}

// ---- (4) generations cap: 3 files total ----------------------------------------------------
{
  clearLogs();
  daemonLog._resetForTests();
  daemonLog.configure({ ORCH_DAEMON_LOG: LOG });
  process.env.ORCH_DAEMON_LOG_MAX_BYTES = '50';
  for (let i = 0; i < 6; i++) daemonLog._tee('out', `generation marker ${i} ${'x'.repeat(60)}\n`);
  ok('live + .1 + .2 exist after repeated rotation',
    fs.existsSync(LOG) && fs.existsSync(`${LOG}.1`) && fs.existsSync(`${LOG}.2`));
  ok('a .3 generation is never created', !fs.existsSync(`${LOG}.3`));
  ok('default cap is 10MB x 3 generations',
    daemonLog.DEFAULT_MAX_BYTES === 10 * 1024 * 1024 && daemonLog.DEFAULT_GENERATIONS === 3);
  delete process.env.ORCH_DAEMON_LOG_MAX_BYTES;
}

// ---- (5) resolvePath contract --------------------------------------------------------------
{
  ok('ORCH_DAEMON_LOG_OFF disables the tee',
    daemonLog.resolvePath({ ORCH_DAEMON_LOG_OFF: '1', ORCH_DAEMON_LOG: LOG }) === null);
  ok('explicit ORCH_DAEMON_LOG wins (even under ZONOID_SKIP_LIVE)',
    daemonLog.resolvePath({ ZONOID_SKIP_LIVE: '1', ORCH_DAEMON_LOG: LOG }) === path.resolve(LOG));
  ok('ZONOID_SKIP_LIVE alone suppresses the implicit runtime default',
    daemonLog.resolvePath({ ZONOID_SKIP_LIVE: '1' }) === null);
  const dflt = daemonLog.resolvePath({});
  ok('default path is <dataDir>/daemon.log', typeof dflt === 'string' && path.basename(dflt) === 'daemon.log');
}

// ---- (6) real install() in a child process --------------------------------------------------
{
  clearLogs();
  const script = path.join(TMP, 'install-probe.js');
  fs.writeFileSync(script, [
    `const daemonLog = require(${JSON.stringify(path.join(__dirname, '..', 'lib', 'daemon-log.js'))});`,
    'const r = daemonLog.install();',
    'console.log("live stdout still works");',
    'console.error("live stderr still works");',
    'console.log("logPath=" + daemonLog.logPath());',
    'if (!r.installed) process.exit(3);',
  ].join('\n'));
  const r = spawnSync(process.execPath, [script], {
    env: { ...process.env, ORCH_DAEMON_LOG: LOG },
    encoding: 'utf8',
    timeout: 30000,
  });
  const teed = read(LOG) || '';
  ok('child exits clean with the wrap installed', r.status === 0);
  ok('original stdout still reaches the console', /live stdout still works/.test(r.stdout));
  ok('original stderr still reaches the console', /live stderr still works/.test(r.stderr));
  ok('stdout is teed into the file', /\[OUT\] live stdout still works/.test(teed));
  ok('stderr is teed into the file', /\[ERR\] live stderr still works/.test(teed));
  ok('logPath() reports the active file', new RegExp(`logPath=.*daemon\\.log`).test(r.stdout));
}

// ---- route harness ---------------------------------------------------------------------------
const overlayStore = require('../lib/overlay');
const activity = require('../lib/activity');
const activityRoute = require('../routes/activity');
const metaRoute = require('../routes/meta');

function fakeSend() {
  let sent = null;
  return {
    send: (res, code, body) => { sent = { code, body }; },
    sent: () => sent,
  };
}

async function callRoute(routeFactory, ctx, url, method = 'GET') {
  const u = new URL(`http://localhost:8787${url}`);
  const handled = await routeFactory(ctx)(u.pathname, method, {}, {}, u, {});
  return { handled };
}

(async () => {
  // ---- (7) GET /version shape ----------------------------------------------------------------
  {
    const s = fakeSend();
    const ctx = {
      send: s.send,
      GIT_HEAD: 'abc123', BOOTED_AT: '2026-01-01T00:00:00.000Z',
      FEATURES: { gatedSearch: true },
      daemonLog: { logPath: () => LOG },
    };
    const { handled } = await callRoute(metaRoute, ctx, '/version');
    const r = s.sent();
    ok('route handles GET /version', handled === true && r.code === 200);
    ok('/version keeps legacy load-bearing fields',
      r.body.head === 'abc123' && r.body.bootedAt === '2026-01-01T00:00:00.000Z' && r.body.features.gatedSearch === true);
    ok('/version reports ok:true', r.body.ok === true);
    ok('/version carries the package version', typeof r.body.version === 'string' && r.body.version.length > 0);
    ok('/version carries node + pid + uptime',
      r.body.node === process.version && r.body.pid === process.pid && typeof r.body.uptime_s === 'number');
    ok('/version reports the daemon log path', r.body.log_path === LOG);
  }

  // ---- (8) GET /status shape -------------------------------------------------------------------
  {
    activity.reset();
    const WS = 'D:\\zonoid';
    const live = activity.begin({ kind: activity.KIND.WORKER, workspace: WS, task: 'w/1' });
    const judge = activity.begin({ kind: activity.KIND.JUDGE, workspace: WS, task: 'j/1' });

    const ov = overlayStore.EMPTY();
    const s = fakeSend();
    const ctx = {
      send: s.send,
      targetOverlay: (_b, u) => ({ ws: u.searchParams.get('workspace'), ov }),
      loops: new Map([
        ['a', { active: true }], ['b', { active: false }], ['c', { active: true }],
      ]),
      daemonLog: { logPath: () => LOG },
    };
    const { handled } = await callRoute(activityRoute, ctx, `/status?workspace=${encodeURIComponent(WS)}`);
    const r = s.sent();
    ok('route handles GET /status', handled === true && r.code === 200 && r.body.ok === true);
    ok('/status keeps the original digest fields',
      typeof r.body.workers_running === 'number' && 'reviews_pending' in r.body
      && 'merges_today' in r.body && 'backoff_until' in r.body);
    ok('/status carries the full governor view', r.body.governor
      && typeof r.body.governor.concurrent_running === 'number'
      && typeof r.body.governor.token_budget === 'number'
      && typeof r.body.governor.backoff_ms === 'number'
      && 'max_concurrency' in r.body.governor);
    ok('/status counts running jobs per kind',
      r.body.running_by_kind && r.body.running_by_kind.worker === 1 && r.body.running_by_kind.judge === 1);
    ok('/status counts active loops', r.body.loops_active === 2);
    ok('/status reports the daemon log path', r.body.log_path === LOG);
    ok('/status carries internal-lane counts when scoped',
      r.body.lanes && typeof r.body.lanes.total === 'number' && r.body.lanes.lanes != null);

    live.end({ status: activity.STATUS.OK });
    judge.end({ status: activity.STATUS.OK });

    // Unscoped: lanes degrade to null (no overlay), everything else still answers.
    const s2 = fakeSend();
    const { handled: h2 } = await callRoute(activityRoute, { ...ctx, send: s2.send }, '/status');
    const r2 = s2.sent();
    ok('unscoped /status still answers', h2 === true && r2.code === 200 && r2.body.ok === true);
    ok('unscoped /status has null lanes (no overlay to project)', r2.body.lanes === null);
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error(e); process.exit(1); });
