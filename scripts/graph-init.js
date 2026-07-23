#!/usr/bin/env node
'use strict';

const path = require('path');
const { parseGraphArgs, runGraphCommand } = require('../packages/cli/bin/zonoid.js');

async function main() {
  const args = process.argv.slice(2);
  let repo = process.cwd();
  if (args[0] && !args[0].startsWith('-')) repo = path.resolve(args.shift());
  const parsed = parseGraphArgs(['node', 'zonoid', 'graph', 'init', ...args]);
  parsed.repo = repo;
  const result = await runGraphCommand(parsed);
  process.exit(result.exitCode || 0);
}

main().catch((error) => {
  console.error(error && error.message || error);
  process.exit(1);
});
