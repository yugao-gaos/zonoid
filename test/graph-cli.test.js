#!/usr/bin/env node
'use strict';

const { parseGraphArgs, runGraphCommand } = require('../packages/cli/bin/zonoid.js');

let pass = 0;
let fail = 0;

function ok(label, value, detail) {
  if (value) {
    console.log(`PASS  ${label}`);
    pass++;
  } else {
    console.log(`FAIL  ${label}${detail ? ` (${detail})` : ''}`);
    fail++;
  }
}

function capture() {
  const values = [];
  return { values, output: (value) => values.push(value) };
}

async function main() {
  const init = parseGraphArgs(['node', 'zonoid', 'graph', 'init', '--remote', 'https://github.com/acme/app.git', '--public', '--yes']);
  ok('parse graph init options', init.command === 'init' && init.remote.endsWith('app.git') && init.private === false && init.yes === true);
  const sync = parseGraphArgs(['node', 'zonoid', 'graph', 'sync', '--latest=false']);
  ok('parse graph sync latest=false', sync.command === 'sync' && sync.latest === false);
  const flush = parseGraphArgs(['node', 'zonoid', 'graph', 'flush', '--no-push']);
  ok('parse graph flush no-push', flush.command === 'flush' && flush.push === false);

  const noYesOutput = capture();
  let noYesOptions;
  const noYes = await runGraphCommand(
    parseGraphArgs(['node', 'zonoid', 'graph', 'init', '--remote', 'https://github.com/acme/app.git']),
    {
      lifecycle: { init: async (_repo, options) => { noYesOptions = options; return { status: 'dry-run', dryRun: true, remote: options.remote }; } },
      output: noYesOutput.output,
    }
  );
  ok('init without yes returns nonzero plan', noYes.status === 'confirmation-required' && noYes.exitCode === 1 && noYesOutput.values[0].action);
  ok('init without yes only requests dry-run', noYesOptions.dryRun === true);

  let defaultCallback;
  const defaultOutput = capture();
  await runGraphCommand(
    parseGraphArgs(['node', 'zonoid', 'graph', 'init', '--dry-run']),
    {
      lifecycle: { init: async (_repo, options) => { defaultCallback = options.createRemoteCallback; return { status: 'dry-run', dryRun: true }; } },
      output: defaultOutput.output,
    }
  );
  ok('gh callback is not selected by default', defaultCallback === undefined);

  const ghCalls = [];
  let explicitCallback;
  const explicitOutput = capture();
  await runGraphCommand(
    parseGraphArgs(['node', 'zonoid', 'graph', 'init', '--create-remote', '--public', '--yes']),
    {
      lifecycle: { init: async (_repo, options) => {
        explicitCallback = options.createRemoteCallback;
        await explicitCallback({ ownerRemote: 'https://github.com/acme/app-graph.git' });
        return { status: 'initialized' };
      } },
      gh: async (args) => { ghCalls.push(args); return { stdout: 'https://github.com/acme/app-graph\n' }; },
      output: explicitOutput.output,
    }
  );
  ok('explicit create-remote selects gh callback', typeof explicitCallback === 'function');
  ok('gh uses argv and requested public visibility', ghCalls.length === 1
    && JSON.stringify(ghCalls[0]) === JSON.stringify(['repo', 'create', 'acme/app-graph', '--public']));
  ok('dispatch prints lifecycle result', explicitOutput.values[0].status === 'initialized' && explicitOutput.values[0].exitCode === 0);

  const commandCalls = [];
  await runGraphCommand(parseGraphArgs(['node', 'zonoid', 'graph', 'flush', '--no-push']), {
    lifecycle: { flush: async (_repo, options) => { commandCalls.push(options); return { status: 'pending' }; } },
    output: () => {},
  });
  ok('dispatch passes flush push=false', commandCalls[0] && commandCalls[0].push === false);

  console.log('-----');
  console.log(`${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((error) => {
  console.error(error && error.stack || error);
  process.exit(1);
});
