'use strict';
/**
 * claude-cli.js — shared helpers for spawning the Claude CLI (`claude -p`) from Node scripts.
 *
 * Extracted from scripts/onboard-learn.js so that lib/headless-drain.js and other callers
 * share the same resolver + .env loader without duplication.
 *
 * Exports:
 *   resolveClaudeBin()       — cross-platform `claude` binary path.
 *   loadEnvForClaude(root)   — load .env.local / .env into process.env (thin shim over load-env).
 *   needsShell(bin)          — true when bin is a Windows .cmd/.bat shim.
 */

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

// ---- binary resolver -----------------------------------------------------------------

/**
 * Resolve the `claude` CLI binary, cross-platform.
 *
 * Resolution order:
 *   1. ZONOID_CLAUDE_BIN or CLAUDE_BIN env override.
 *   2. Well-known absolute install paths (Unix: /opt/homebrew, /usr/local, /usr).
 *   3. Windows: %APPDATA%\Claude\claude-code\<version>\claude.exe (newest build first).
 *      The desktop app does NOT add itself to PATH on Windows, so we probe the directory.
 *   4. PATH lookup via `where` (Windows) / `which` (Unix).
 *   5. Bare 'claude' fallback — OS resolves at spawn time.
 */
function resolveClaudeBin() {
  const override = process.env.ZONOID_CLAUDE_BIN || process.env.CLAUDE_BIN;
  if (override) return override;

  const isWin = process.platform === 'win32';

  if (!isWin) {
    for (const c of ['/opt/homebrew/bin/claude', '/usr/local/bin/claude', '/usr/bin/claude']) {
      try { if (fs.existsSync(c)) return c; } catch { /* ignore */ }
    }
  }

  if (isWin) {
    try {
      const base = path.join(process.env.APPDATA || '', 'Claude', 'claude-code');
      const exes = fs.readdirSync(base)
        .map((v) => path.join(base, v, 'claude.exe'))
        .filter((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } })
        .sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs);
      if (exes.length) return exes[0];
    } catch { /* ignore — base dir may not exist */ }
  }

  try {
    const r = spawnSync(isWin ? 'where' : 'which', ['claude'], { encoding: 'utf8', windowsHide: true });
    const hit = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
    if (hit) return hit;
  } catch { /* ignore */ }

  return 'claude';
}

// ---- .env loader shim ----------------------------------------------------------------

/**
 * Load .env.local then .env from rootDir into process.env (no-override — real env wins).
 * Returns the list of keys set. Silently no-ops when lib/load-env is absent.
 */
function loadEnvForClaude(rootDir) {
  try {
    return require('./load-env').loadEnvFiles(rootDir);
  } catch {
    return [];
  }
}

// ---- shell shim detection ------------------------------------------------------------

/**
 * Returns true when the resolved binary is a Windows .cmd/.bat shim that spawnSync
 * cannot exec directly — in that case pass shell:true to the spawn call.
 */
function needsShell(bin) {
  return process.platform === 'win32' && /\.(cmd|bat)$/i.test(bin);
}

module.exports = { resolveClaudeBin, loadEnvForClaude, needsShell };
