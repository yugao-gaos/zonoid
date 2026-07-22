'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_DIRNAME = '.zonoid';

function userHome(env = process.env) {
  return env.HOME || env.USERPROFILE || os.homedir();
}

function canonicalPath(dir) {
  const resolved = path.resolve(String(dir || ''));
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function legacyBaseDir(env = process.env) {
  return path.join(userHome(env), '.claude', 'orchestrator');
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

function externalDataDir(env = process.env) {
  if (process.platform === 'darwin') {
    return path.join(userHome(env), 'Library', 'Application Support', 'zonoid');
  }
  if (process.platform === 'win32') {
    const appData = env.APPDATA
      ? path.resolve(env.APPDATA)
      : path.join(userHome(env), 'AppData', 'Roaming');
    return path.join(appData, 'zonoid');
  }
  const xdgDataHome = env.XDG_DATA_HOME
    ? path.resolve(env.XDG_DATA_HOME)
    : path.join(userHome(env), '.local', 'share');
  return path.join(xdgDataHome, 'zonoid');
}

function hasLiveRuntimeData(dir) {
  const liveSubdirs = ['overlay', 'sessions', 'worktrees', 'wake', 'scheduled-tasks', 'tasks', 'adapters', 'models', 'certs'];
  const liveFiles = ['agents.json', 'loops.json', 'loop.json', 'workspaces.json', 'token', 'backend.env', 'op-cache.json', 'tool-analytics.json', 'scheduled-wakeups.json'];
  try {
    for (const sub of liveSubdirs) {
      if (fs.existsSync(path.join(dir, sub))) return true;
    }
    for (const file of liveFiles) {
      if (fs.existsSync(path.join(dir, file))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function defaultDataDir(env = process.env) {
  const legacyRuntimeDir = runtimeUnder(legacyBaseDir(env));
  if (hasLiveRuntimeData(legacyRuntimeDir)) return canonicalPath(legacyRuntimeDir);
  return canonicalPath(externalDataDir(env));
}

function resolveDataDir(env = process.env) {
  if (env.ORCH_DATA) return canonicalPath(env.ORCH_DATA);
  if (env.ZONOID_DATA) return canonicalPath(env.ZONOID_DATA);

  if (env.CLAUDE_PLUGIN_DATA) {
    const legacy = canonicalPath(env.CLAUDE_PLUGIN_DATA);
    return looksLikeZonoidInstall(legacy) ? runtimeUnder(legacy) : legacy;
  }

  return defaultDataDir(env);
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
  userHome,
  canonicalPath,
  legacyBaseDir,
  looksLikeZonoidInstall,
  externalDataDir,
  hasLiveRuntimeData,
  defaultDataDir,
  resolveDataDir,
  runtimePath,
  adapterDataDir,
  adapterPath,
};
