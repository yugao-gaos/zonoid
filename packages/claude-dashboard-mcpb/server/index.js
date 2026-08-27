#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');

const installDir = path.resolve(process.env.ZONOID_INSTALL_DIR || '');
const required = ['mcp-graph.js', 'daemon.js', 'package.json'];
if (!process.env.ZONOID_INSTALL_DIR || required.some((file) => !fs.existsSync(path.join(installDir, file)))) {
  console.error('Zonoid Dashboard requires ZONOID_INSTALL_DIR to point to an installed Zonoid checkout. Reconfigure the Claude Desktop extension and choose the directory containing mcp-graph.js.');
  process.exit(1);
}

const child = spawn(process.execPath, [path.join(installDir, 'mcp-graph.js')], {
  cwd: installDir,
  env: { ...process.env, ORCH_CLIENT: process.env.ORCH_CLIENT || 'claude' },
  stdio: 'inherit',
  windowsHide: true,
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}

child.on('error', (error) => {
  console.error(`Unable to start the configured Zonoid MCP server: ${error.message}`);
  process.exitCode = 1;
});
child.on('exit', (code, signal) => {
  process.exitCode = signal ? 1 : (code == null ? 1 : code);
});
