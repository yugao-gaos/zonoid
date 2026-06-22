#!/usr/bin/env node
'use strict';
// Portable, cross-platform installer for the zonoid orchestrator.
//
// Generates the two config files Claude Code needs, with paths correct for THIS machine/OS:
//   1. <workspace>/.mcp.json          — registers the orchestrator-graph MCP server (the task tools)
//   2. <settings target>/settings.json — wires the Node hooks (gate, classifier, daemon launcher, …)
//
// Everything is invoked as `node "<dir>/<file>.js"`, so there is NO dependency on bash/jq/curl —
// the install works identically on Windows, macOS and Linux. Re-runnable (idempotent): it removes
// any prior zonoid hook entries before re-adding the current set.
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

// Forward slashes work as path separators on every OS (Node accepts them on Windows too) and avoid
// backslash-escaping noise inside the JSON command strings.
const fwd = (p) => p.replace(/\\/g, '/');
const INSTALL_FWD = fwd(INSTALL_DIR);
const hookCmd = (name) => `node "${INSTALL_FWD}/hooks/${name}.js"`;
const dashboardUrl = (workspace = WORKSPACE) => `http://localhost:${PORT}/graph?workspace=${encodeURIComponent(path.resolve(workspace))}`;

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

// ── run ──────────────────────────────────────────────────────────────────────
console.log(`zonoid installer${DRY ? ' (dry-run)' : ''}`);
console.log(`  install dir : ${INSTALL_DIR}`);
console.log(`  workspace   : ${WORKSPACE}`);
console.log(`  settings    : ${SETTINGS_FILE}${USER_SCOPE ? ' (user/global)' : ' (project)'}`);
console.log(`  daemon port : ${PORT}`);
console.log('');
installMcp();
installSettings();
if (!DRY) {
  console.log('\nDone. Notes:');
  console.log('  • Start a NEW Claude Code CLI session so it reloads .mcp.json + settings.json.');
  console.log('  • Hooks (the gate) run in the CLI only — the desktop app does not execute settings.json hooks.');
  console.log(`  • Dashboard: ${dashboardUrl()}`);
}
