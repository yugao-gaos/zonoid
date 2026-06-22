#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const retrievalWeights = require('../lib/search/retrieval-weights');
const benchmark = require('../lib/search/diffusion-shadow-benchmark');

function usage() {
  return [
    'Usage: node scripts/diffusion-predictive-shadow-benchmark.js [--workspace <path>] [--format markdown|json] [--output <path>]',
    '',
    'Runs an offline shadow comparison of direct retrievalWeight feedback and diffusion-style predictive-error feedback.',
    'The script reads .graph/gate-labeled.jsonl, graph state, and retrieval weights; it never writes live .graph journals.',
  ].join('\n');
}

function parseArgs(argv) {
  const args = {
    workspace: process.cwd(),
    format: 'markdown',
    output: null,
  };
  for (let i = 2; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      args.help = true;
    } else if (arg === '--workspace') {
      args.workspace = argv[++i] || args.workspace;
    } else if (arg === '--format') {
      args.format = argv[++i] || args.format;
    } else if (arg === '--json') {
      args.format = 'json';
    } else if (arg === '--markdown') {
      args.format = 'markdown';
    } else if (arg === '--output' || arg === '-o') {
      args.output = argv[++i] || null;
    } else {
      throw new Error(`unknown argument: ${arg}`);
    }
  }
  args.workspace = path.resolve(args.workspace);
  args.format = String(args.format || 'markdown').toLowerCase();
  if (args.format !== 'markdown' && args.format !== 'json') {
    throw new Error('--format must be markdown or json');
  }
  return args;
}

function main() {
  let args;
  try {
    args = parseArgs(process.argv);
  } catch (err) {
    console.error(err.message);
    console.error(usage());
    process.exitCode = 1;
    return;
  }

  if (args.help) {
    console.log(usage());
    return;
  }

  const rows = benchmark.readGateRows(args.workspace);
  if (!rows.length) {
    console.error(`No labeled gate rows found at ${path.join(args.workspace, '.graph', 'gate-labeled.jsonl')}`);
    process.exitCode = 1;
    return;
  }

  const graphState = benchmark.loadGraphState(args.workspace);
  if (!graphState || !graphState.graph || !graphState.graph.tasks.length) {
    console.error(`No usable graph state found under ${path.join(args.workspace, '.graph')}. Expected checkpoint.json, graph.json, or state.json.`);
    process.exitCode = 1;
    return;
  }

  const initialWeights = retrievalWeights.latestWeightMap(args.workspace);
  const report = benchmark.runShadowBenchmark({
    rows,
    graph: graphState.graph,
    initialWeights,
  });

  const rendered = args.format === 'json'
    ? JSON.stringify(benchmark.serializableReport(report), null, 2) + '\n'
    : benchmark.renderMarkdownReport(report, {
        workspace: args.workspace,
        graphFile: graphState.file,
      });

  if (args.output) {
    const out = path.resolve(args.workspace, args.output);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.writeFileSync(out, rendered, 'utf8');
    console.log(`Wrote ${args.format} report to ${out}`);
  } else {
    process.stdout.write(rendered);
  }
}

if (require.main === module) main();

module.exports = {
  parseArgs,
};
