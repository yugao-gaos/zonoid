'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function loadDashboardLaunch() {
  const candidates = [
    process.env.ZONOID_ROOT && path.join(process.env.ZONOID_ROOT, 'lib', 'dashboard-launch.js'),
    path.resolve(__dirname, '../../../lib/dashboard-launch.js'),
    path.resolve(process.cwd(), 'lib/dashboard-launch.js'),
    path.join(os.homedir(), '.claude', 'orchestrator', 'lib', 'dashboard-launch.js'),
  ].filter(Boolean);
  for (const candidate of candidates) {
    try {
      if (fs.existsSync(candidate)) return require(candidate);
    } catch {
      // Try the next configured install location.
    }
  }
  throw new Error('Zonoid dashboard launch contract unavailable; set ZONOID_ROOT to the Zonoid install directory');
}

function openerCommand(url, platform = process.platform) {
  if (platform === 'darwin') return { command: 'open', args: [url] };
  if (platform === 'win32') return { command: 'cmd', args: ['/c', 'start', '', url] };
  return { command: 'xdg-open', args: [url] };
}

function openExternal(url, { platform = process.platform, spawnImpl = spawn } = {}) {
  const invocation = openerCommand(url, platform);
  return new Promise((resolve) => {
    let child;
    try {
      child = spawnImpl(invocation.command, invocation.args, {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
    } catch (error) {
      resolve({ ok: false, error: error.message, ...invocation });
      return;
    }

    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      resolve({ ...result, ...invocation });
    };
    child.once('error', (error) => finish({ ok: false, error: error.message }));
    child.once('spawn', () => {
      if (typeof child.unref === 'function') child.unref();
      finish({ ok: true });
    });
  });
}

async function dashboardOpen({ workspace, origin, port, open = true, opener } = {}) {
  const { buildDashboardLaunch } = loadDashboardLaunch();
  const launch = buildDashboardLaunch({
    workspace,
    origin: origin || process.env.ZONOID_DASHBOARD_ORIGIN,
    port: port || process.env.ORCH_PORT,
    viewer: 'opencode',
  });
  const opened = open ? await (opener || openExternal)(launch.url) : { ok: false, skipped: true };
  return { ok: true, launch, opened };
}

module.exports = {
  loadDashboardLaunch,
  openerCommand,
  openExternal,
  dashboardOpen,
};
