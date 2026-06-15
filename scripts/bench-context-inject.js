'use strict';
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const NODE = process.execPath;
const BENCH_ARM = path.join(__dirname, 'bench-arm.js');

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

const PROBLEM = arg('problem', 'v4-hard');
const TRIALS  = parseInt(arg('trials', '3'), 10);
const MODEL   = arg('model', 'sonnet');

const ARMS = [
  { id: 0, label: 'baseline',       armFlag: 'off', extraFlags: [] },
  { id: 1, label: 'global-summary', armFlag: 'on',  extraFlags: ['--with-global-summary'] },
  { id: 2, label: 'window',         armFlag: 'on',  extraFlags: ['--with-window'] },
  { id: 3, label: 'both',           armFlag: 'on',  extraFlags: ['--with-global-summary', '--with-window'] },
];

const INPUT_W = 1.0, OUTPUT_W = 5.0, CACHE_READ_W = 0.1, CACHE_CREATION_W = 1.25;
function weightedCost(u) {
  return (u.input_tokens||0)*INPUT_W + (u.output_tokens||0)*OUTPUT_W +
         (u.cache_read_input_tokens||0)*CACHE_READ_W +
         (u.cache_creation_input_tokens||0)*CACHE_CREATION_W;
}

function extractMetrics(transcriptPath) {
  if (!transcriptPath || !fs.existsSync(transcriptPath)) return { full_lifecycle_tokens: 0, weighted_cost: 0 };
  let tokens = 0, cost = 0;
  for (const line of fs.readFileSync(transcriptPath, 'utf8').split('\n')) {
    if (!line.trim()) continue;
    let obj; try { obj = JSON.parse(line); } catch { continue; }
    const u = (obj.message && obj.message.usage) || obj.usage;
    if (u) {
      tokens += (u.input_tokens||0)+(u.output_tokens||0)+(u.cache_read_input_tokens||0)+(u.cache_creation_input_tokens||0);
      cost   += weightedCost(u);
    }
  }
  return { full_lifecycle_tokens: tokens, weighted_cost: cost };
}

const OUT_DIR = path.join(REPO, 'bench', 'context-inject');
fs.mkdirSync(OUT_DIR, { recursive: true });
const RESULTS_FILE = path.join(OUT_DIR, 'results.jsonl');

console.log(`bench-context-inject: problem=${PROBLEM} trials=${TRIALS} arms=4`);

for (const arm of ARMS) {
  for (let trial = 0; trial < TRIALS; trial++) {
    console.log(`  ARM${arm.id}(${arm.label}) trial ${trial}...`);
    const args = [BENCH_ARM,
      '--spec', `bench/specs/${PROBLEM}.md`,
      '--arm', arm.armFlag,
      '--problem', PROBLEM,
      '--trial', String(trial),
      '--model', MODEL,
      ...arm.extraFlags,
    ];
    const env = { ...process.env, ORCH_GATE_OFF: '1' };
    const r = spawnSync(NODE, args, { cwd: REPO, env, timeout: 660000, encoding: 'utf8' });
    const pass = r.status === 0;
    // bench-arm writes transcripts to bench/transcripts/<problem>-<arm>-<trial>.jsonl
    const transcriptPath = path.join(REPO, 'bench', 'transcripts',
      `${PROBLEM}-${arm.armFlag}-${trial}.jsonl`);
    const { full_lifecycle_tokens, weighted_cost } = extractMetrics(transcriptPath);
    const result = {
      arm: arm.id, arm_label: arm.label, trial, problem: PROBLEM,
      pass, full_lifecycle_tokens, weighted_cost,
      timestamp: new Date().toISOString(),
    };
    fs.appendFileSync(RESULTS_FILE, JSON.stringify(result) + '\n');
    console.log(`    ${pass ? 'PASS' : 'FAIL'} cost=${weighted_cost.toFixed(0)} tokens=${full_lifecycle_tokens}`);
  }
}
console.log(`Results written to ${RESULTS_FILE}`);
