#!/usr/bin/env node
'use strict';
// Portable, cross-platform installer for the zonoid orchestrator.
//
// Generates the config Claude Code needs, with paths correct for THIS machine/OS, and wires the
// repo-local capabilities so the vendored @zonoid/core package installs end-to-end on its own
// (no separate @zonoid/cli package required):
//   1. <workspace>/.mcp.json          — registers the orchestrator-graph MCP server (the task tools)
//   2. <settings target>/settings.json — wires the Node hooks (gate, classifier, daemon launcher, …)
//   3. ~/.claude/skills/*             — symlinks each install-dir skill into the user skills dir
//   4. .git/hooks/pre-push            — runs the repo's test script before every push
//   5. <workspace>/CLAUDE.md          — appends the orchestrator instructions section (once)
//   6. POST /workspace                — best-effort daemon workspace registration
//
// Everything is invoked as `node "<dir>/<file>.js"`, so there is NO dependency on bash/jq/curl —
// the install works identically on Windows, macOS and Linux. Re-runnable (idempotent): it removes
// any prior zonoid hook entries before re-adding the current set, and every step below no-ops when
// already installed.
//
// Usage:
//   node bin/install.js                 # wire the current workspace, hooks -> <workspace>/.claude/settings.json
//   node bin/install.js --user          # wire hooks into ~/.claude/settings.json (global, all workspaces)
//   node bin/install.js --workspace DIR # target a different workspace root (default: cwd)
//   node bin/install.js --install-dir D # orchestrator source dir (default: this repo)
//   node bin/install.js --port 8788     # daemon port (default: 8787)
//   node bin/install.js --dry-run       # print what would change without writing

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { spawnSync } = require('child_process');

// ── args ─────────────────────────────────────────────────────────────────────
const argv = process.argv.slice(2);
function flag(name) { return argv.includes(name); }
function opt(name, dflt) { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt; }

const DRY = flag('--dry-run') || flag('--print');
const PORT = String(opt('--port', process.env.ORCH_PORT || '8787'));
const INSTALL_DIR = path.resolve(opt('--install-dir', path.join(__dirname, '..')));
// Resolve the workspace target to its containing repo root (nearest ancestor with .graph/.git);
// fall back to the requested dir verbatim when no marker is found so we can still locate the
// project-scoped settings file. --workspace DIR overrides cwd as the starting point.
const WORKSPACE = (() => {
  const start = path.resolve(opt('--workspace', process.cwd()));
  try {
    const { repoRoot } = require(path.join(INSTALL_DIR, 'lib', 'workspace-registry.js'));
    return repoRoot(start) || start;
  } catch { return start; }
})();
const USER_SCOPE = flag('--user');
const SETTINGS_FILE = USER_SCOPE
  ? path.join(os.homedir(), '.claude', 'settings.json')
  : path.join(WORKSPACE, '.claude', 'settings.json');

const SKILLS_DIR = path.join(os.homedir(), '.claude', 'skills');

// Forward slashes work as path separators on every OS (Node accepts them on Windows too) and avoid
// backslash-escaping noise inside the JSON command strings.
const fwd = (p) => String(p).replace(/\\/g, '/');
const INSTALL_FWD = fwd(INSTALL_DIR);
const hookCmd = (name) => `node "${INSTALL_FWD}/hooks/${name}.js"`;
const dashboardUrl = (workspace = WORKSPACE, port = PORT) => `http://localhost:${port}/graph?workspace=${encodeURIComponent(path.resolve(workspace))}`;

// ── the complete hook wiring (one source of truth) ───────────────────────────
const HOOKS = {
  SessionStart: [{ hooks: [{ type: 'command', command: hookCmd('start-daemon'), timeout: 8 }] }],
  UserPromptSubmit: [{ hooks: [{ type: 'command', command: hookCmd('classify'), timeout: 10 }] }],
  PreToolUse: [
    { matcher: '*', hooks: [{ type: 'command', command: hookCmd('orch-stop') }] },
    { matcher: 'Write|Edit', hooks: [{ type: 'command', command: hookCmd('orch-gate') }] },
    { matcher: 'Bash', hooks: [{ type: 'command', command: hookCmd('orch-gate-bash') }] },
  ],
  PostToolUse: [
    { matcher: 'Agent|Task', hooks: [{ type: 'command', command: hookCmd('post-agent') }] },
    { matcher: 'TaskCreate', hooks: [{ type: 'command', command: hookCmd('suggest-links') }] },
    { matcher: '*', hooks: [{ type: 'command', command: hookCmd('orch-posttool-starttask') }] },
  ],
  SubagentStart: [{ hooks: [{ type: 'command', command: hookCmd('subagent-start') }] }],
  SubagentStop: [{ hooks: [{ type: 'command', command: hookCmd('subagent-stop') }] }],
};
const STATUSLINE = { type: 'command', command: hookCmd('statusline'), refreshInterval: 2 };
const MCP_ALLOW = [
  'mcp__orchestrator-graph__next_action', 'mcp__orchestrator-graph__get_graph',
  'mcp__orchestrator-graph__set_status', 'mcp__orchestrator-graph__loop_control',
  'mcp__orchestrator-graph__get_task_detail', 'mcp__orchestrator-graph__start_task',
  'mcp__orchestrator-graph__complete_task', 'mcp__orchestrator-graph__branch_task',
  'mcp__orchestrator-graph__configure_task', 'mcp__orchestrator-graph__suggest_links',
  'mcp__orchestrator-graph__add_dependency', 'mcp__orchestrator-graph__record_decision',
  'mcp__orchestrator-graph__request_guidance', 'mcp__orchestrator-graph__search_knowledge',
  'mcp__orchestrator-graph__subconscious_assignment',
  'mcp__orchestrator-graph__subconscious_execution_permit',
];
// Any hook command pointing at one of our hook files is "ours" — used to strip stale entries so the
// install is idempotent (and migrates the old .sh entries to .js).
const HOOK_NAMES = ['start-daemon', 'classify', 'orch-stop', 'orch-gate', 'orch-gate-bash',
  'post-agent', 'suggest-links', 'orch-posttool-starttask', 'subagent-start', 'subagent-stop', 'statusline'];
const isOurs = (cmd) => typeof cmd === 'string' && HOOK_NAMES.some((n) => cmd.includes(`/hooks/${n}.`) || cmd.includes(`\\hooks\\${n}.`));

// ── helpers ──────────────────────────────────────────────────────────────────
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); }
  catch (e) { return e.code === 'ENOENT' ? {} : null; }   // null = present but unparseable -> abort
}
function writeJson(file, obj) {
  if (DRY) { console.log(`\n--- would write ${file} ---\n${JSON.stringify(obj, null, 2)}`); return; }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + '\n');
  console.log(`  ✓ wrote ${file}`);
}

// Run a command and capture trimmed stdout, throwing on non-zero exit. Used to
// resolve the git hooks dir (handles worktrees + core.hooksPath portably).
function runCapture(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', windowsHide: true, ...opts });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed`);
  return (r.stdout || '').trim();
}

// ── 1. .mcp.json ─────────────────────────────────────────────────────────────
// Repo-relative when the MCP script lives in the workspace (committable, no per-machine edits);
// absolute otherwise (global install used across many workspaces).
function installMcp() {
  const mcpFile = path.join(WORKSPACE, '.mcp.json');
  const inWorkspace = fwd(INSTALL_DIR) === fwd(WORKSPACE);
  const scriptArg = inWorkspace ? 'mcp-graph.js' : `${INSTALL_FWD}/mcp-graph.js`;
  const existing = readJson(mcpFile);
  if (existing === null) { console.error(`  ! ${mcpFile} exists but is not valid JSON — leaving it untouched`); return; }
  existing.mcpServers = existing.mcpServers || {};
  existing.mcpServers['orchestrator-graph'] = {
    type: 'stdio',
    command: 'node',
    args: [scriptArg],
    env: { ORCH_PORT: PORT },
  };
  writeJson(mcpFile, existing);
}

// ── 2. settings.json (hooks + statusLine + MCP allow-list) ───────────────────
function installSettings() {
  const settings = readJson(SETTINGS_FILE);
  if (settings === null) { console.error(`  ! ${SETTINGS_FILE} exists but is not valid JSON — aborting to avoid clobbering it`); process.exitCode = 1; return; }

  // hooks: strip our prior entries (any event), then add the current set.
  settings.hooks = settings.hooks || {};
  for (const ev of Object.keys(settings.hooks)) {
    settings.hooks[ev] = (settings.hooks[ev] || []).filter((entry) => {
      const cmds = (entry && entry.hooks) || [];
      return !cmds.some((h) => isOurs(h && h.command));
    });
  }
  for (const [ev, entries] of Object.entries(HOOKS)) {
    settings.hooks[ev] = (settings.hooks[ev] || []).concat(entries);
    if (settings.hooks[ev].length === 0) delete settings.hooks[ev];
  }

  settings.statusLine = STATUSLINE;

  // permissions.allow: union (don't drop the user's existing allows).
  settings.permissions = settings.permissions || {};
  const allow = new Set(settings.permissions.allow || []);
  for (const a of MCP_ALLOW) allow.add(a);
  settings.permissions.allow = Array.from(allow);

  writeJson(SETTINGS_FILE, settings);
}

// ── 3. skills ────────────────────────────────────────────────────────────────
/**
 * Create a directory link from `dest` pointing at `src`, using the best
 * available strategy on this platform: plain symlink → Windows junction →
 * deep copy. Injection points (`symlinkFn`, `cpFn`) let tests force the
 * junction / copy branches on any host regardless of OS privilege.
 *
 * @returns {'symlink'|'junction'|'copy'|null} winning strategy, or null on total failure
 */
function linkSkill(src, dest, symlinkFn = fs.symlinkSync, cpFn = fs.cpSync) {
  // Strategy 1: plain symlink (works on Unix and Windows with elevation)
  try { symlinkFn(src, dest); return 'symlink'; } catch (_e1) { /* fall through */ }
  // Strategy 2: junction (works without elevation on Windows for directories)
  try { symlinkFn(src, dest, 'junction'); return 'junction'; } catch (_e2) { /* fall through */ }
  // Strategy 3: deep copy (always works, but no live-update benefit)
  try { cpFn(src, dest, { recursive: true }); return 'copy'; } catch (_e3) { /* total failure */ }
  return null;
}

// Symlink each directory under <INSTALL_DIR>/skills into ~/.claude/skills.
// Idempotent: skips correct links, repairs broken/wrong-target ones. Under DRY,
// prints what it would do and writes nothing.
function installSkills() {
  const srcDir = path.join(INSTALL_DIR, 'skills');
  if (!fs.existsSync(srcDir)) { console.log('  · no skills/ dir in install — skipping'); return; }

  const skills = fs.readdirSync(srcDir).filter(
    (s) => { try { return fs.statSync(path.join(srcDir, s)).isDirectory(); } catch { return false; } }
  );

  let installed = 0, skipped = 0, repaired = 0;
  if (!DRY) fs.mkdirSync(SKILLS_DIR, { recursive: true });

  for (const skill of skills) {
    const src  = path.join(srcDir, skill);
    const dest = path.join(SKILLS_DIR, skill);

    if (fs.existsSync(dest)) {
      try {
        const stat = fs.lstatSync(dest);
        if (stat.isSymbolicLink()) {
          const target = fs.readlinkSync(dest);
          if (target === src) { skipped++; continue; }
        } else {
          const hasSkillMd = fs.existsSync(path.join(dest, 'skill.md')) ||
                             fs.existsSync(path.join(dest, 'SKILL.md'));
          if (hasSkillMd) { skipped++; continue; }
        }
      } catch (_) { /* unreadable — reinstall below */ }
      if (DRY) { console.log(`  · would repair skill '${skill}'`); repaired++; continue; }
      fs.rmSync(dest, { recursive: true, force: true });
      repaired++;
    }

    if (DRY) { console.log(`  · would install skill '${skill}' (${fwd(src)} → ${fwd(dest)})`); installed++; continue; }
    const strategy = linkSkill(src, dest);
    if (strategy) { installed++; console.log(`  ✓ skill installed: ${skill} (${strategy})`); }
    else { console.log(`  ! skill '${skill}' could not be installed (all strategies failed)`); }
  }

  if (skipped > 0)  console.log(`  ✓ ${skipped} skill(s) already up to date`);
  if (repaired > 0) console.log(`  ↻ ${repaired} skill(s) repaired`);
  if (installed > 0 && DRY) console.log(`  · ${installed} skill(s) would be installed`);
}

// ── 4. pre-push test guard ────────────────────────────────────────────────────
// Resolve the test command from the workspace package.json: prefer test:all,
// fall back to test, else null (no guard).
function prePushTestCommand(cwd) {
  const pkgPath = path.join(cwd, 'package.json');
  if (!fs.existsSync(pkgPath)) return null;
  let pkg;
  try { pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')); }
  catch (_) { return null; }
  const scripts = pkg && pkg.scripts;
  if (!scripts || typeof scripts !== 'object') return null;
  if (typeof scripts['test:all'] === 'string' && scripts['test:all'].trim()) return 'npm run test:all';
  if (typeof scripts.test === 'string' && scripts.test.trim()) return 'npm test';
  return null;
}

function prePushTestHookScript(command) {
  return `#!/bin/sh
# Zonoid pre-push test guard
set -eu

echo "zonoid: running ${command} before push"
${command}
`;
}

// Install the pre-push test guard into the workspace git repo. Never overwrites
// a FOREIGN pre-push hook (warns instead); skips cleanly when no test script or
// not a git repo. Under DRY, prints intent and writes nothing.
function installPrePushTestHook(cwd) {
  const command = prePushTestCommand(cwd);
  if (!command) {
    console.log('  · no package.json test script found — skipping pre-push test guard');
    return;
  }

  let hooksDir;
  try {
    const raw = runCapture('git', ['rev-parse', '--git-path', 'hooks'], { cwd });
    hooksDir = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw);
  } catch (_) {
    console.log('  · not a git repo — skipping pre-push test guard');
    return;
  }

  const hookPath = path.join(hooksDir, 'pre-push');
  const MARKER = 'Zonoid pre-push test guard';
  const script = prePushTestHookScript(command);

  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, 'utf8');
    if (existing.includes(MARKER)) {
      if (existing.includes(command)) {
        console.log('  ✓ pre-push test guard already installed');
        return;
      }
      if (DRY) { console.log(`  · would update pre-push test guard (${command})`); return; }
      fs.writeFileSync(hookPath, script);
      try { fs.chmodSync(hookPath, 0o755); } catch (_) { /* harmless on Windows */ }
      console.log('  ↻ pre-push test guard updated');
      return;
    }
    if (existing.trim() === '') {
      if (DRY) { console.log(`  · would write pre-push test guard (${command}, replacing empty file)`); return; }
      fs.writeFileSync(hookPath, script);
      try { fs.chmodSync(hookPath, 0o755); } catch (_) { /* harmless on Windows */ }
      console.log('  ✓ pre-push test guard installed');
      return;
    }
    console.log('  ⚠ a foreign pre-push hook exists — not overwriting. Add the Zonoid test guard manually.');
    return;
  }

  if (DRY) { console.log(`  · would write pre-push test guard (${command})`); return; }
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(hookPath, script);
  try { fs.chmodSync(hookPath, 0o755); } catch (_) { /* harmless on Windows */ }
  console.log('  ✓ pre-push test guard installed');
}

// ── 5. CLAUDE.md merge ─────────────────────────────────────────────────────────
// Rewrite any localhost dashboard URLs in the source instructions to point at
// THIS workspace (so the appended section links to the right graph).
function renderClaudeInstructions(content, workspace = WORKSPACE, port = PORT) {
  const url = dashboardUrl(workspace, port);
  return String(content)
    .replace(/http:\/\/localhost:\d+\/graph\?workspace=[^\s`)>\]]+/g, url)
    .replace(/http:\/\/localhost:\d+\/graph(?!\?workspace=)/g, url);
}

// Append the install-dir CLAUDE.md orchestrator section to <workspace>/CLAUDE.md
// ONLY if an "Orchestrator dashboard" section is not already present. Under DRY,
// prints intent and writes nothing.
function installClaudeInstructions(workspace = WORKSPACE) {
  const src = path.join(INSTALL_DIR, 'CLAUDE.md');
  if (!fs.existsSync(src)) { console.log('  · source CLAUDE.md not found in install dir — skipping'); return; }
  const dest = path.join(workspace, 'CLAUDE.md');
  const srcContent = renderClaudeInstructions(fs.readFileSync(src, 'utf8'), workspace);

  if (fs.existsSync(dest)) {
    const existing = fs.readFileSync(dest, 'utf8');
    if (existing.includes('Orchestrator dashboard')) {
      console.log('  ✓ CLAUDE.md already has orchestrator section');
      return;
    }
    if (DRY) { console.log(`  · would append orchestrator section to ${dest}`); return; }
    fs.writeFileSync(dest, existing + '\n\n' + srcContent);
    console.log('  ✓ CLAUDE.md orchestrator section appended');
  } else {
    if (DRY) { console.log(`  · would create ${dest}`); return; }
    fs.writeFileSync(dest, srcContent);
    console.log('  ✓ CLAUDE.md created');
  }
}

// ── 6. workspace registration ──────────────────────────────────────────────────
// Best-effort POST /workspace to the daemon. A daemon-down / error NEVER fails
// the install. Under DRY, prints intent and makes no HTTP call.
function registerWorkspace(workspace = WORKSPACE, port = PORT) {
  return new Promise((resolve) => {
    // Resolve workspace -> its containing repo root; fall back to the dir itself.
    let repoPath = workspace;
    try {
      const { repoRoot } = require(path.join(INSTALL_DIR, 'lib', 'workspace-registry.js'));
      repoPath = repoRoot(workspace) || workspace;
    } catch { /* lib unavailable — register the dir verbatim */ }

    if (DRY) { console.log(`  · would POST /workspace { path: ${fwd(repoPath)} } to localhost:${port}`); resolve(); return; }

    const body = JSON.stringify({ path: repoPath });
    const req = http.request(
      { hostname: 'localhost', port: Number(port), path: '/workspace', method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) } },
      (res) => { res.resume(); console.log(`  ✓ workspace registered (${res.statusCode})`); resolve(); }
    );
    req.on('error', () => { console.log('  ⚠ could not register workspace (daemon may not be running)'); resolve(); });
    req.setTimeout(3000, () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

// ── run ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`zonoid installer${DRY ? ' (dry-run)' : ''}`);
  console.log(`  install dir : ${INSTALL_DIR}`);
  console.log(`  workspace   : ${WORKSPACE}`);
  console.log(`  settings    : ${SETTINGS_FILE}${USER_SCOPE ? ' (user/global)' : ' (project)'}`);
  console.log(`  daemon port : ${PORT}`);
  console.log('');
  installMcp();
  installSettings();
  installSkills();
  installPrePushTestHook(WORKSPACE);
  installClaudeInstructions(WORKSPACE);
  await registerWorkspace(WORKSPACE);
  if (!DRY) {
    console.log('\nDone. Notes:');
    console.log('  • Start a NEW Claude Code CLI session so it reloads .mcp.json + settings.json.');
    console.log('  • Hooks (the gate) run in the CLI only — the desktop app does not execute settings.json hooks.');
    console.log(`  • Dashboard: ${dashboardUrl()}`);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  // config
  INSTALL_DIR,
  DRY,
  PORT,
  WORKSPACE,
  // helpers
  fwd,
  hookCmd,
  dashboardUrl,
  readJson,
  writeJson,
  runCapture,
  isOurs,
  // writers / steps
  installMcp,
  installSettings,
  linkSkill,
  installSkills,
  prePushTestCommand,
  prePushTestHookScript,
  installPrePushTestHook,
  renderClaudeInstructions,
  installClaudeInstructions,
  registerWorkspace,
};
