#!/usr/bin/env node
'use strict';

const path = require('path');
const { spawnSync } = require('child_process');
const { buildDashboardLaunch, DEFAULT_PORT } = require('../lib/dashboard-launch');

function usage() {
  return [
    'Usage: zonoid-dashboard [--workspace DIR] [--port PORT] [--origin URL] [--json] [--open]',
    '',
    'Print a workspace-scoped dashboard launch URL. --open uses the system browser.',
    'ZONOID_DASHBOARD_ORIGIN configures the daemon origin; the default is loopback.',
  ].join('\n');
}

function parseArgs(argv) {
  const out = { workspace: null, port: null, origin: null, json: false, open: false, help: false };
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--json') out.json = true;
    else if (arg === '--open') out.open = true;
    else if (arg === '--help' || arg === '-h') out.help = true;
    else if (['--workspace', '--port', '--origin'].includes(arg)) {
      if (!argv[i + 1]) throw new Error(`${arg} requires a value`);
      out[arg.slice(2)] = argv[++i];
    } else throw new Error(`unknown argument: ${arg}`);
  }
  return out;
}

function openExternal(url, platform = process.platform, spawn = spawnSync) {
  const command = platform === 'darwin' ? 'open' : platform === 'win32' ? 'rundll32.exe' : 'xdg-open';
  const args = platform === 'win32' ? ['url.dll,FileProtocolHandler', url] : [url];
  const result = spawn(command, args, { stdio: 'ignore', windowsHide: true });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`failed to open dashboard (${command} exited ${result.status})`);
}

function run(argv = process.argv.slice(2), env = process.env, io = process, opener = openExternal) {
  const args = parseArgs(argv);
  if (args.help) {
    io.stdout.write(usage() + '\n');
    return null;
  }
  const workspace = path.resolve(args.workspace || process.cwd());
  const launch = buildDashboardLaunch({
    workspace,
    port: args.port || env.ORCH_PORT || DEFAULT_PORT,
    origin: args.origin || env.ZONOID_DASHBOARD_ORIGIN || null,
  });
  io.stdout.write((args.json ? JSON.stringify(launch, null, 2) : launch.url) + '\n');
  if (args.open) opener(launch.url);
  return launch;
}

if (require.main === module) {
  try { run(); }
  catch (error) {
    console.error(`zonoid-dashboard: ${error.message}`);
    process.exitCode = 1;
  }
}

module.exports = { usage, parseArgs, openExternal, run };
