#!/usr/bin/env node
'use strict';

/**
 * Runs one API-backed judge loop outside the daemon process.
 *
 * The daemon owns scheduling, leases, concurrency, and timeout enforcement. This worker only performs
 * the CPU/model-heavy round trip: /judge/next -> provider API -> /judge/verdict, then mirrors the
 * provider's drain-result stdout/stderr/exit code for the parent drain runner.
 */

async function main() {
  let args;
  try {
    args = JSON.parse(process.argv[2] || '{}');
  } catch (e) {
    process.stderr.write(`api-judge-worker: invalid JSON args: ${e && e.message ? e.message : e}\n`);
    process.exit(1);
  }

  const backend = require('../lib/llm-backend');
  const provider = backend.getProvider(args.provider);
  if (!provider || provider.kind !== 'api' || typeof provider.runJudgeLoop !== 'function') {
    process.stderr.write(`api-judge-worker: invalid api provider ${JSON.stringify(args.provider)}\n`);
    process.exit(1);
  }

  let result;
  try {
    result = await provider.runJudgeLoop({
      daemonUrl: args.daemonUrl,
      budget: args.budget,
      node: args.node || undefined,
      model: args.model || undefined,
      key: args.key || undefined,
      workspace: args.workspace || undefined,
      timeoutMs: args.timeoutMs,
    });
  } catch (e) {
    result = {
      exitCode: 1,
      stdout: '',
      stderr: `runJudgeLoop threw: ${e && e.message ? e.message : e}`,
    };
  }

  if (result && result.stdout) process.stdout.write(String(result.stdout));
  if (result && result.stderr) process.stderr.write(String(result.stderr));
  process.exit(Number.isInteger(result && result.exitCode) ? result.exitCode : 0);
}

main();
