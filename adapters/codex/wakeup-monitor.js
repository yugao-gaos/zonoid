#!/usr/bin/env node
'use strict';
const readline = require('readline');
const { createWakeDeliveryMonitor } = require('../../lib/codex-wakeup-delivery');

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--session') out.sessionId = argv[++i] || '';
    else if (a === '--codex') out.command = argv[++i] || '';
    else if (a === '--help' || a === '-h') out.help = true;
  }
  return out;
}

function usage() {
  process.stderr.write('Usage: tail -n0 -F <session.fire> | node adapters/codex/wakeup-monitor.js --session <codex-session-id> [--codex codex]\n');
}

const args = parseArgs(process.argv.slice(2));
if (args.help) {
  usage();
  process.exit(0);
}
if (!args.sessionId) {
  usage();
  process.exit(2);
}

const monitor = createWakeDeliveryMonitor({
  sessionId: args.sessionId,
  command: args.command || 'codex',
});

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const r = monitor.handleLine(line);
  if (r && r.error) process.stderr.write(`${r.error}\n`);
});
