#!/usr/bin/env node
// 4-arm context-injection bench runner
// arm 0: no injection (baseline)
// arm 1: global summary only
// arm 2: sliding window only
// arm 3: global summary + sliding window (combined)
//
// Uses bench-arm.js and context injectors from the WORKTREE (arm-flags feature lives here).
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const WORKTREE = path.resolve(__dirname, '..');

const GS = require(path.join(WORKTREE, 'scripts/context-inject-global-summary.js'));
const WC = require(path.join(WORKTREE, 'scripts/context-inject-sliding-window.js'));

const SCENARIOS = [
  { spec: 'bench/specs/greenfield.md', problem: 'greenfield' },
];

const ARM_CONFIGS = [
  { armId: 0, label: 'baseline',       useGlobal: false, useWindow: false },
  { armId: 1, label: 'global-summary', useGlobal: true,  useWindow: false },
  { armId: 2, label: 'sliding-window', useGlobal: false, useWindow: true  },
  { armId: 3, label: 'combined',       useGlobal: true,  useWindow: true  },
];

const TRIAL_TIMEOUT_MS = 2 * 60 * 1000;
const GLOBAL_BUDGET_MS = 8 * 60 * 1000;

async function main() {
  const startMs = Date.now();

  process.stderr.write('[4arm] Fetching global summary...\n');
  const globalSummary = await GS.getGlobalSummary();
  process.stderr.write('[4arm] done: ' + JSON.stringify(globalSummary) + '\n');

  process.stderr.write('[4arm] Fetching sliding window...\n');
  const windowCtx = await WC.getWindowContext(5);
  process.stderr.write('[4arm] window tasks: ' + windowCtx.length + '\n');

  const results = [];

  for (const scenario of SCENARIOS) {
    for (const armCfg of ARM_CONFIGS) {
      const elapsed = Date.now() - startMs;
      if (elapsed > GLOBAL_BUDGET_MS) {
        process.stderr.write('[4arm] 8min global budget exhausted — stopping early\n');
        break;
      }

      process.stderr.write('\n[4arm] arm ' + armCfg.armId + ' (' + armCfg.label + ') — ' + scenario.problem + '...\n');

      const env = { ...process.env, ZONOID_REPO: WORKTREE, ORCH_GATE_OFF: '1' };
      if (armCfg.useGlobal) env.BENCH_INJECT_GLOBAL_SUMMARY = JSON.stringify(globalSummary);
      if (armCfg.useWindow) env.BENCH_INJECT_WINDOW = JSON.stringify(windowCtx);

      const problemLabel = scenario.problem + '-ci' + armCfg.armId;

      const t0 = Date.now();
      const r = spawnSync('node', [
        path.join(WORKTREE, 'scripts/bench-arm.js'),
        '--spec', scenario.spec,
        '--arm', 'off',
        '--trial', String(armCfg.armId),
        '--problem', problemLabel,
        '--model', 'haiku',
      ], {
        cwd: WORKTREE,
        env,
        encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: TRIAL_TIMEOUT_MS,
      });

      const wallMs = Date.now() - t0;
      const timedOut = r.signal !== null || (r.status === null) || wallMs >= TRIAL_TIMEOUT_MS;

      let result = null;
      if (r.stdout) {
        const lines = r.stdout.trim().split('\n').filter(l => l.trim());
        if (lines.length > 0) {
          try { result = JSON.parse(lines[lines.length - 1]); } catch { /* skip */ }
        }
      }

      if (r.stderr) process.stderr.write('[bench-arm] ' + r.stderr.slice(-1000) + '\n');

      const entry = {
        armId: armCfg.armId,
        label: armCfg.label,
        problem: scenario.problem,
        useGlobal: armCfg.useGlobal,
        useWindow: armCfg.useWindow,
        solved: timedOut ? null : (result ? result.solved : false),
        wallMs: timedOut ? null : wallMs,
        timedOut,
        exitCode: r.status,
        raw: result,
      };

      process.stderr.write('[4arm] result: solved=' + entry.solved + ', wallMs=' + entry.wallMs + ', timedOut=' + timedOut + '\n');
      results.push(entry);
    }
  }

  const totalMs = Date.now() - startMs;

  const armStats = ARM_CONFIGS.map((cfg) => {
    const armResults = results.filter((r) => r.armId === cfg.armId);
    const completed = armResults.filter((r) => !r.timedOut);
    const solved = completed.filter((r) => r.solved).length;
    const total = completed.length;
    return {
      armId: cfg.armId,
      label: cfg.label,
      solved,
      total,
      pct: total > 0 ? Math.round((solved / total) * 100) : null,
    };
  });

  const output = {
    runAt: new Date().toISOString(),
    totalMs,
    partial: results.length < SCENARIOS.length * ARM_CONFIGS.length,
    scenarios: SCENARIOS.map((s) => s.problem),
    globalSummary,
    windowTaskCount: windowCtx.length,
    armStats,
    results,
  };

  const outPath = path.join(WORKTREE, 'bench-4arm-results.json');
  fs.writeFileSync(outPath, JSON.stringify(output, null, 2), 'utf8');
  process.stderr.write('[4arm] Written: ' + outPath + '\n');

  process.stderr.write('\n=== 4-ARM SUMMARY ===\n');
  for (const s of armStats) {
    const pct = s.pct !== null ? s.pct + '%' : 'N/A (timed out)';
    process.stderr.write('arm' + s.armId + ' (' + s.label + '): ' + s.solved + '/' + s.total + ' (' + pct + ')\n');
  }

  process.stdout.write(JSON.stringify(armStats) + '\n');
}

main().catch((err) => {
  process.stderr.write('[4arm] FATAL: ' + err.message + '\n' + err.stack + '\n');
  process.exit(1);
});
