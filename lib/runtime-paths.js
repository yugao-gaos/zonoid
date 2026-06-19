'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_DIRNAME = '.zonoid';

function legacyBaseDir() {
  return path.join(os.homedir(), '.claude', 'orchestrator');
}

function looksLikeZonoidInstall(dir) {
  if (!dir) return false;
  try {
    return fs.existsSync(path.join(dir, 'daemon.js'))
      && fs.existsSync(path.join(dir, 'mcp-graph.js'))
      && fs.existsSync(path.join(dir, 'package.json'));
  } catch {
    return false;
  }
}

function runtimeUnder(dir) {
  return path.join(dir, RUNTIME_DIRNAME);
}

function resolveDataDir(env = process.env) {
  if (env.ORCH_DATA) return path.resolve(env.ORCH_DATA);
  if (env.ZONOID_DATA) return path.resolve(env.ZONOID_DATA);

  if (env.CLAUDE_PLUGIN_DATA) {
    const legacy = path.resolve(env.CLAUDE_PLUGIN_DATA);
    return looksLikeZonoidInstall(legacy) ? runtimeUnder(legacy) : legacy;
  }

  return runtimeUnder(legacyBaseDir());
}

function runtimePath(...parts) {
  return path.join(resolveDataDir(), ...parts);
}

function adapterDataDir(adapter) {
  const name = String(adapter || '').replace(/[^A-Za-z0-9._-]/g, '_') || 'unknown';
  return runtimePath('adapters', name);
}

function adapterPath(adapter, ...parts) {
  return path.join(adapterDataDir(adapter), ...parts);
}

module.exports = {
  RUNTIME_DIRNAME,
  legacyBaseDir,
  looksLikeZonoidInstall,
  resolveDataDir,
  runtimePath,
  adapterDataDir,
  adapterPath,
};
