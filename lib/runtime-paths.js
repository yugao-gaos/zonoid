'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');

const RUNTIME_DIRNAME = '.zonoid';
const LIVE_SUBDIRS = ['overlay', 'sessions', 'worktrees', 'wake', 'scheduled-tasks', 'tasks', 'adapters', 'models', 'certs'];
const LIVE_FILES = ['agents.json', 'loops.json', 'loop.json', 'workspaces.json', 'token', 'backend.env', 'op-cache.json', 'tool-analytics.json', 'scheduled-wakeups.json'];
const MIGRATABLE_SUBDIRS = LIVE_SUBDIRS.filter((name) => name !== 'worktrees');
const MIGRATION_MARKER = '.legacy-migration-incomplete';

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
  try {
    for (const sub of LIVE_SUBDIRS) {
      if (fs.existsSync(path.join(dir, sub))) return true;
    }
    for (const file of LIVE_FILES) {
      if (fs.existsSync(path.join(dir, file))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function hasAuthoritativeRuntimeData(dir) {
  try {
    for (const sub of MIGRATABLE_SUBDIRS) {
      if (fs.existsSync(path.join(dir, sub))) return true;
    }
    for (const file of LIVE_FILES) {
      if (fs.existsSync(path.join(dir, file))) return true;
    }
  } catch {
    return false;
  }
  return false;
}

function copyEntryIfMissing(source, destination) {
  const exists = (entry) => {
    try { fs.lstatSync(entry); return true; }
    catch (err) {
      if (err && err.code === 'ENOENT') return false;
      throw err;
    }
  };
  const sourceStat = fs.lstatSync(source);

  if (sourceStat.isDirectory()) {
    let copied = false;
    if (exists(destination)) {
      if (!fs.lstatSync(destination).isDirectory()) return false;
    } else {
      try {
        fs.mkdirSync(destination, { mode: sourceStat.mode });
        copied = true;
      } catch (err) {
        if (!err || err.code !== 'EEXIST') throw err;
        if (!fs.lstatSync(destination).isDirectory()) return false;
      }
    }
    for (const name of fs.readdirSync(source)) {
      if (copyEntryIfMissing(path.join(source, name), path.join(destination, name))) copied = true;
    }
    return copied;
  }

  if (exists(destination)) return false;
  try {
    if (sourceStat.isSymbolicLink()) {
      fs.symlinkSync(fs.readlinkSync(source), destination);
    } else {
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
    }
    return true;
  } catch (err) {
    if (err && err.code === 'EEXIST') return false;
    throw err;
  }
}

function explicitDataDir(env = process.env) {
  if (env.ORCH_DATA) return canonicalPath(env.ORCH_DATA);
  if (env.ZONOID_DATA) return canonicalPath(env.ZONOID_DATA);
  if (!env.CLAUDE_PLUGIN_DATA) return null;
  const legacy = canonicalPath(env.CLAUDE_PLUGIN_DATA);
  return looksLikeZonoidInstall(legacy) ? runtimeUnder(legacy) : legacy;
}

function migrateLegacyRuntime(env = process.env) {
  const override = explicitDataDir(env);
  if (override) return { status: 'explicit_override', migrated: false, dataDir: override, copied: [] };

  const source = canonicalPath(runtimeUnder(legacyBaseDir(env)));
  const destination = canonicalPath(externalDataDir(env));
  if (source === destination) return { status: 'already_external', migrated: false, dataDir: destination, source, destination, copied: [] };

  const marker = path.join(destination, MIGRATION_MARKER);
  const incomplete = fs.existsSync(marker);
  if (!hasAuthoritativeRuntimeData(source)) {
    return { status: 'no_legacy_state', migrated: false, dataDir: destination, source, destination, copied: [] };
  }
  if (!incomplete && hasAuthoritativeRuntimeData(destination)) {
    return { status: 'external_authoritative', migrated: false, dataDir: destination, source, destination, copied: [] };
  }

  const copied = [];
  try {
    fs.mkdirSync(destination, { recursive: true });
    fs.writeFileSync(marker, 'copying legacy runtime state; source remains authoritative until this marker is removed\n', { flag: 'wx' });
  } catch (err) {
    if (!err || err.code !== 'EEXIST') {
      return { status: 'migration_failed', migrated: false, dataDir: source, source, destination, copied, error: err.message };
    }
  }

  try {
    for (const name of [...MIGRATABLE_SUBDIRS, ...LIVE_FILES]) {
      const from = path.join(source, name);
      if (!fs.existsSync(from)) continue;
      if (copyEntryIfMissing(from, path.join(destination, name))) copied.push(name);
    }
    fs.rmSync(marker, { force: true });
    return { status: 'migrated', migrated: true, dataDir: destination, source, destination, copied };
  } catch (err) {
    return { status: 'migration_failed', migrated: false, dataDir: source, source, destination, copied, error: err.message };
  }
}

function defaultDataDir(env = process.env) {
  const source = canonicalPath(runtimeUnder(legacyBaseDir(env)));
  const destination = canonicalPath(externalDataDir(env));
  const incomplete = fs.existsSync(path.join(destination, MIGRATION_MARKER));
  const legacyAuthoritative = hasAuthoritativeRuntimeData(source);
  if (incomplete && legacyAuthoritative) return source;
  if (hasAuthoritativeRuntimeData(destination)) return destination;
  if (legacyAuthoritative) return source;
  return destination;
}

function resolveDataDir(env = process.env) {
  return explicitDataDir(env) || defaultDataDir(env);
}

function resolveWorktreeDir(env = process.env) {
  if (env.ORCH_DATA || env.ZONOID_DATA || env.CLAUDE_PLUGIN_DATA) {
    return path.join(resolveDataDir(env), 'worktrees');
  }
  return path.join(canonicalPath(externalDataDir(env)), 'worktrees');
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
  hasAuthoritativeRuntimeData,
  migrateLegacyRuntime,
  defaultDataDir,
  resolveDataDir,
  resolveWorktreeDir,
  runtimePath,
  adapterDataDir,
  adapterPath,
};
