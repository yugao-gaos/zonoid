#!/usr/bin/env node
// 4-arm context-injection bench runner — mix-set suite scenarios
// arm 0: baseline (no injection)
// arm 1: global summary only
// arm 2: sliding window only
// arm 3: global summary + sliding window (combined)
'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');

// Load all suite scenarios dynamically from bench/suite/scenarios/*/scenario.json
const SUITE_DIR = path.join(REPO, 'bench/suite/scenarios');
const SCENARIOS = fs.readdirSync(SUITE_DIR)
  .filter(d => fs.existsSync(path.join(SUITE_DIR, d, 'scenario.json')))
  .map(d => {
    const meta = JSON.parse(fs.readFileSync(path.join(SUITE_DIR, d, 'scenario.json'), 'utf8'));
    return { name: meta.name, spec: meta.spec, grader: meta.grader, artifact: meta.artifact, minimalSource: meta.minimalSource };
  })
  .sort((a, b) => a.name.localeCompare(b.name));

const ARM_CONFIGS = [
  { armId: 0, label: 'baseline',       flags: [] },
  { armId: 1, label: 'global-summary', flags: ['--with-global-summary'] },
  { armId: 2, label: 'sliding-window', flags: ['--with-window'] },
  { armId: 3, label: 'combined',       flags: ['--with-global-summary', '--with-window'] },
];

const TRIAL_TIMEOUT_MS = 3 * 60 * 1000;

async function main() {
  const DRY_RUN = process.argv.includes('--dry-run');
  process.stderr.write(`[4arm-mix] ${SCENARIOS.length} scenarios x 4 arms${DRY_RUN ? ' (DRY RUN)' : ''}\n`);

  const results = [];

  for (const scenario of SCENARIOS) {
    for (const armCfg of ARM_CONFIGS) {
      const armStr = armCfg.armId === 0 ? 'off' : 'on';
      const problemLabel = scenario.name + '-ci' + armCfg.armId;

      const baseArgs = [
        path.join(REPO, 'scripts/bench-arm.js'),
        '--spec', scenario.spec,
        '--arm', armStr,
        '--trial', String(armCfg.armId),
        '--problem', problemLabel,
        '--grader', scenario.grader,
        '--artifact', scenario.artifact || 'bench/sandbox/solution.js',
        ...(scenario.minimalSource ? ['--minimal-source', scenario.minimalSource] : []),
        '--model', 'haiku',
      ];
      const injFlags = armCfg.armId > 0 ? armCfg.flags : [];
      const args = [...baseArgs, ...injFlags, ...(DRY_RUN ? ['--dry-run'] : [])];

      process.stderr.write(`\n[4arm-mix] arm${armCfg.armId} (${armCfg.label}) -- ${scenario.name}...\n`);

      const env = { ...process.env, ZONOID_REPO: REPO, ORCH_GATE_OFF: '1' };
      const r = spawnSync(process.execPath, args, {
        cwd: REPO, env, encoding: 'utf8',
        maxBuffer: 32 * 1024 * 1024,
        timeout: DRY_RUN ? 30000 : TRIAL_TIMEOUT_MS,
      });

      if (r.stderr) process.stderr.write('[bench-arm] ' + r.stderr.slice(-500) + '\n');

      let result = null;
      if (!DRY_RUN && r.stdout) {
        const lines = r.stdout.trim().split('\n').filter(l => l.trim());
        if (lines.length > 0) {
          try { result = JSON.parse(lines[lines.length - 1]); } catch (_) {}
        }
      }

      results.push({
        armId: armCfg.armId,
        label: armCfg.label,
        scenario: scenario.name,
        exitCode: r.status,
        timedOut: r.signal !== null || r.status === null,
        solved: result ? result.solved : null,
        wallMs: result ? result.wallMs : null,
      });
    }
  }

  if (!DRY_RUN) {
    const outPath = path.join(REPO, 'bench-4arm-mix-results.json');
    fs.writeFileSync(outPath, JSON.stringify({ runAt: new Date().toISOString(), scenarios: SCENARIOS.map(s => s.name), results }, null, 2));
    process.stderr.write('[4arm-mix] Written: ' + outPath + '\n');
  }

  process.stderr.write('\n=== DONE ===\n');
}

main().catch(err => { process.stderr.write('[4arm-mix] FATAL: ' + err.stack + '\n'); process.exit(1); });
