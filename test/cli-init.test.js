#!/usr/bin/env node
'use strict';
const { spawnSync } = require('child_process');
const path = require('path');
const os = require('os');
const {
  parseInitArgs,
  mergeCursorHooks,
  mergeCodexHooks,
  VALID_HARNESSES,
  scheduleWakeupScriptPath,
  opencodePluginHasScheduleWakeup,
  INSTALL_DIR,
  dirHasLiveData,
  resolveInstallDir,
  linkSkill,
  installRepoSkill,
  installOpencodeRepoSkills,
  opencodePluginDepVersion,
  writeMcp,
  writeCodexMcp,
  writeOpencodeMcp,
  orchestratorMcpEntry,
  opencodeMcpEntry,
  stripCodexOrchTable,
  graphAutocommitHookScript,
  mergeGraphAutocommitFlag,
  parseOnboardArgs,
  dashboardUrl,
  renderClaudeInstructions,
} = require('../packages/cli/bin/zonoid.js');
const fs = require('fs');

const zonoid = path.join(__dirname, '..', 'packages', 'cli', 'bin', 'zonoid.js');
let failed = 0;

function ok(label, cond) {
  if (cond) console.log('ok', label);
  else { console.error('FAIL', label); failed++; }
}

ok('default harness is claude', parseInitArgs(['node', 'zonoid', 'init']).harness === 'claude');
ok('cursor harness parsed', parseInitArgs(['node', 'zonoid', 'init', '--harness', 'cursor']).harness === 'cursor');
ok('opencode harness parsed', parseInitArgs(['node', 'zonoid', 'init', '--harness', 'opencode']).harness === 'opencode');
ok('--service flag parsed', parseInitArgs(['node', 'zonoid', 'init', '--service', '--harness', 'codex']).service === true);
ok('invalid harness not in VALID_HARNESSES', !VALID_HARNESSES.has('invalid'));
ok('onboard defaults repo to cwd', parseOnboardArgs(['node', 'zonoid', 'onboard']).repo === process.cwd());
ok('onboard injects default --repo passthrough', parseOnboardArgs(['node', 'zonoid', 'onboard']).passThrough[0] === '--repo');
ok('onboard parses explicit --repo', parseOnboardArgs(['node', 'zonoid', 'onboard', '--repo', '/tmp/x', '--force']).repo === '/tmp/x');
ok('onboard preserves flags', parseOnboardArgs(['node', 'zonoid', 'onboard', '--repo', '/tmp/x', '--force']).passThrough.includes('--force'));

const clientRepo = path.join(os.tmpdir(), 'client repo');
const clientDash = dashboardUrl(clientRepo, '8787');
ok('dashboardUrl pins and URL-encodes workspace path',
  clientDash === `http://localhost:8787/graph?workspace=${encodeURIComponent(path.resolve(clientRepo))}`);
{
  const rendered = renderClaudeInstructions(
    'A http://localhost:8787/graph\nB http://localhost:8787/graph?workspace=%2Fold%2Frepo',
    clientRepo,
    '8788'
  );
  const expected = `http://localhost:8788/graph?workspace=${encodeURIComponent(path.resolve(clientRepo))}`;
  ok('renderClaudeInstructions rewrites generic dashboard URL', rendered.includes(`A ${expected}`));
  ok('renderClaudeInstructions rewrites existing pinned dashboard URL', rendered.includes(`B ${expected}`));
}

// ── CDX-2: multi-harness --harness parsing (comma-separated and/or repeatable) ──
ok('default harnesses is [claude]',
  JSON.stringify(parseInitArgs(['node', 'zonoid', 'init']).harnesses) === JSON.stringify(['claude']));
ok('comma-separated --harness claude,codex → both',
  JSON.stringify(parseInitArgs(['node', 'zonoid', 'init', '--harness', 'claude,codex']).harnesses) === JSON.stringify(['claude', 'codex']));
ok('repeated --harness flags → both',
  JSON.stringify(parseInitArgs(['node', 'zonoid', 'init', '--harness', 'claude', '--harness', 'codex']).harnesses) === JSON.stringify(['claude', 'codex']));
ok('duplicate harness de-duped',
  JSON.stringify(parseInitArgs(['node', 'zonoid', 'init', '--harness', 'codex,codex']).harnesses) === JSON.stringify(['codex']));
ok('multi-harness keeps .harness = first for back-compat',
  parseInitArgs(['node', 'zonoid', 'init', '--harness', 'claude,codex']).harness === 'claude');
ok('--service parsed alongside comma list',
  parseInitArgs(['node', 'zonoid', 'init', '--harness', 'claude,codex', '--service']).service === true);

const merged = mergeCursorHooks(
  { version: 1, hooks: { postToolUse: [{ command: '/keep/me.sh' }] } },
  { version: 1, hooks: { preToolUse: [{ command: '/new/gate.sh', matcher: 'Write' }] } },
  [{ event: 'postToolUse', entries: [{ command: '/new/todo.sh' }] }]
);
ok('merge preserves existing hook', merged.hooks.postToolUse.some((e) => e.command === '/keep/me.sh'));
ok('merge adds sample hook', merged.hooks.preToolUse.some((e) => e.command === '/new/gate.sh'));
ok('merge appends extra hook', merged.hooks.postToolUse.some((e) => e.command === '/new/todo.sh'));
ok('merge skips duplicate command', merged.hooks.postToolUse.length === 2);

const codexMerged = mergeCodexHooks(
  { hooks: {
    PreToolUse: [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/old/adapters/codex/hooks/orch-gate-bash.sh' }] },
      { matcher: 'Write', hooks: [{ type: 'command', command: 'C:\\old\\adapters\\codex\\hooks\\orch-gate.sh' }] },
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/user/custom-hook.sh' }] },
    ],
    Stop: [{ hooks: [{ type: 'command', command: '/user/stop-hook.sh' }] }],
  } },
  { hooks: {
    PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: '/new/adapters/codex/hooks/orch-gate-bash.sh' }] }],
    UserPromptSubmit: [{ hooks: [{ type: 'command', command: '/new/adapters/codex/hooks/classify-relay.sh' }] }],
  } },
);
ok('mergeCodexHooks preserves user PreToolUse hook',
  codexMerged.hooks.PreToolUse.some((e) => e.hooks.some((h) => h.command === '/user/custom-hook.sh')));
ok('mergeCodexHooks preserves unrelated Stop hook',
  codexMerged.hooks.Stop.some((e) => e.hooks.some((h) => h.command === '/user/stop-hook.sh')));
ok('mergeCodexHooks replaces stale Codex hook',
  !JSON.stringify(codexMerged).includes('/old/adapters/codex/hooks/orch-gate-bash.sh') &&
  !JSON.stringify(codexMerged).includes('C:\\old\\adapters\\codex\\hooks\\orch-gate.sh') &&
  JSON.stringify(codexMerged).includes('/new/adapters/codex/hooks/orch-gate-bash.sh'));
ok('mergeCodexHooks adds missing sample event',
  codexMerged.hooks.UserPromptSubmit.some((e) => e.hooks.some((h) => h.command.includes('classify-relay.sh'))));

const codexStartMatcher = 'mcp__orchestrator-graph__start_task|mcp__orchestrator_graph__start_task|start_task';
const codexLifecycleMatcher = 'spawn_agents.*|mcp__orchestrator-graph__complete_task|mcp__orchestrator_graph__complete_task|complete_task|Agent|Task';
const codexTomlSample = fs.readFileSync(path.join(__dirname, '..', 'adapters', 'codex', 'config.toml.sample'), 'utf8');
const codexHooksSample = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'adapters', 'codex', 'hooks.json.sample'), 'utf8'));
const codexPostMatchers = codexHooksSample.hooks.PostToolUse.map((h) => h.matcher);
ok('codex config.toml sample start_task matcher includes legacy, Codex, and bare names',
  codexTomlSample.includes(`matcher = "${codexStartMatcher}"`));
ok('codex hooks.json sample start_task matcher includes legacy, Codex, and bare names',
  codexPostMatchers.includes(codexStartMatcher));
ok('codex config.toml sample lifecycle matcher includes spawn, complete_task, Agent, and Task names',
  codexTomlSample.includes(`matcher = "${codexLifecycleMatcher}"`));
ok('codex hooks.json sample lifecycle matcher includes spawn, complete_task, Agent, and Task names',
  codexPostMatchers.includes(codexLifecycleMatcher));

const bad = spawnSync(process.execPath, [zonoid, 'init', '--harness', 'invalid'], { encoding: 'utf8' });
ok('invalid --harness exits non-zero', bad.status !== 0);
ok('invalid --harness prints error', (bad.stderr || bad.stdout || '').includes('Unknown --harness'));

const help = spawnSync(process.execPath, [zonoid], { encoding: 'utf8' });
const usage = help.stdout || '';
ok('usage lists cursor', usage.includes('cursor'));
ok('usage lists opencode', usage.includes('opencode'));
ok('usage lists codex', usage.includes('codex'));
ok('usage lists --service', usage.includes('--service'));
ok('usage lists onboard command', usage.includes('onboard'));

const swScript = scheduleWakeupScriptPath();
ok('scheduleWakeupScriptPath under adapters/common', swScript.replace(/\\/g, '/').endsWith('adapters/common/schedule-wakeup.sh'));
ok('scheduleWakeupScriptPath uses INSTALL_DIR', swScript.startsWith(INSTALL_DIR));

const pluginTs = path.join(__dirname, '..', 'packages', 'opencode-plugin', 'zonoid.ts');
ok('repo opencode plugin has schedule_wakeup', opencodePluginHasScheduleWakeup(fs.readFileSync(pluginTs, 'utf8')));

// ── Invariant 1: dirHasLiveData ──────────────────────────────────────────────
// Use os.tmpdir() fixtures — no network required.
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-test-'));
  try {
    // Empty dir → no live data
    ok('dirHasLiveData: empty dir is false', !dirHasLiveData(base));

    // Dir with overlay/ subdir → live data
    const withOverlay = path.join(base, 'with-overlay');
    fs.mkdirSync(path.join(withOverlay, 'overlay'), { recursive: true });
    ok('dirHasLiveData: overlay/ detected', dirHasLiveData(withOverlay));

    // Dir with sessions/ subdir → live data
    const withSessions = path.join(base, 'with-sessions');
    fs.mkdirSync(path.join(withSessions, 'sessions'), { recursive: true });
    ok('dirHasLiveData: sessions/ detected', dirHasLiveData(withSessions));

    // Dir with worktrees/ subdir → live data
    const withWorktrees = path.join(base, 'with-worktrees');
    fs.mkdirSync(path.join(withWorktrees, 'worktrees'), { recursive: true });
    ok('dirHasLiveData: worktrees/ detected', dirHasLiveData(withWorktrees));

    // Dir with .zonoid/ runtime dir → live data
    const withZonoid = path.join(base, 'with-zonoid');
    fs.mkdirSync(path.join(withZonoid, '.zonoid'), { recursive: true });
    ok('dirHasLiveData: .zonoid/ detected', dirHasLiveData(withZonoid));

    // Dir with `workspace` file → live data
    const withWorkspace = path.join(base, 'with-workspace');
    fs.mkdirSync(withWorkspace, { recursive: true });
    fs.writeFileSync(path.join(withWorkspace, 'workspace'), '{}');
    ok('dirHasLiveData: workspace file detected', dirHasLiveData(withWorkspace));

    // Dir with `token` file → live data
    const withToken = path.join(base, 'with-token');
    fs.mkdirSync(withToken, { recursive: true });
    fs.writeFileSync(path.join(withToken, 'token'), 'abc');
    ok('dirHasLiveData: token file detected', dirHasLiveData(withToken));

    // Dir with only unrelated files → no live data
    const withOther = path.join(base, 'with-other');
    fs.mkdirSync(withOther, { recursive: true });
    fs.writeFileSync(path.join(withOther, 'package.json'), '{}');
    ok('dirHasLiveData: unrelated files are false', !dirHasLiveData(withOther));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ── Invariant 3: resolveInstallDir ──────────────────────────────────────────
// The repo root (3 levels above packages/cli/bin) IS a checkout because the
// test itself runs from the repo, so resolveInstallDir() must prefer it.
{
  const repoRoot = path.resolve(__dirname, '..');
  const hasDaemon  = fs.existsSync(path.join(repoRoot, 'daemon.js'));
  const hasMcp     = fs.existsSync(path.join(repoRoot, 'mcp-graph.js'));
  const hasPkg     = fs.existsSync(path.join(repoRoot, 'package.json'));
  if (hasDaemon && hasMcp && hasPkg) {
    // Full checkout — resolveInstallDir() should return repoRoot (or its realpath)
    const resolved = fs.realpathSync(resolveInstallDir());
    const expected = fs.realpathSync(repoRoot);
    ok('resolveInstallDir prefers local checkout', resolved === expected);
  } else {
    // Not a full checkout (e.g. running from an npm install) — just verify it
    // returns a string and does not throw.
    ok('resolveInstallDir returns a string', typeof resolveInstallDir() === 'string');
  }
}

// ── Invariant 2: linkSkill() — stub-injected fallback branch coverage ────────
// These tests inject synthetic symlinkFn / cpFn stubs so that the junction and
// copy branches of linkSkill() actually execute on this host regardless of OS
// privilege level.  A broken fallback path will cause the wrong strategy to be
// returned and the corresponding ok() assertion to fail.

// (a) symlink fails for 2-arg call but succeeds for 'junction' → returns 'junction'
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-skill-test-'));
  try {
    const src  = path.join(base, 'src-skill');
    const dest = path.join(base, 'dest-skill');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'skill.md'), '# junction test');

    // symlinkFn throws only when called WITHOUT the 'junction' type arg
    const stubSymlink = (s, d, type) => {
      if (!type) throw Object.assign(new Error('EPERM stub'), { code: 'EPERM' });
      // 'junction' call: delegate to the real fs.symlinkSync
      fs.symlinkSync(s, d, type);
    };

    const result = linkSkill(src, dest, stubSymlink, fs.cpSync);
    ok('linkSkill junction branch: returns junction', result === 'junction');
    ok('linkSkill junction branch: dest is a junction/symlink', fs.existsSync(dest));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// (b) symlinkFn throws for BOTH symlink and junction; cpFn wraps fs.cpSync → returns 'copy'
//     AND dest is a real dir with skill.md present
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-skill-test-'));
  try {
    const src  = path.join(base, 'src-skill');
    const dest = path.join(base, 'dest-skill');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'skill.md'), '# copy test');

    // symlinkFn always throws
    const stubSymlink = () => { throw Object.assign(new Error('EPERM stub'), { code: 'EPERM' }); };
    // cpFn delegates to real fs.cpSync
    const stubCp = (s, d, opts) => fs.cpSync(s, d, opts);

    const result = linkSkill(src, dest, stubSymlink, stubCp);
    ok('linkSkill copy branch: returns copy', result === 'copy');
    ok('linkSkill copy branch: dest dir exists', fs.existsSync(dest) && fs.statSync(dest).isDirectory());
    ok('linkSkill copy branch: skill.md present in dest', fs.existsSync(path.join(dest, 'skill.md')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// (c) default happy path (no stubs) → returns 'symlink' (or at minimum a non-null strategy)
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-skill-test-'));
  try {
    const src  = path.join(base, 'src-skill');
    const dest = path.join(base, 'dest-skill');
    fs.mkdirSync(src, { recursive: true });
    fs.writeFileSync(path.join(src, 'skill.md'), '# happy path test');

    const result = linkSkill(src, dest);
    ok('linkSkill happy path: returns a non-null strategy', result !== null);
    ok('linkSkill happy path: dest exists after chain', fs.existsSync(dest));
    const resolvedDest = (result === 'copy') ? dest : fs.realpathSync(dest);
    ok('linkSkill happy path: skill.md readable via dest', fs.existsSync(path.join(resolvedDest, 'skill.md')));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ── Client-repo skill install: Codex guidance belongs in target repo ─────────
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-repo-skill-'));
  try {
    const cwd = path.join(base, 'client-repo');
    fs.mkdirSync(cwd, { recursive: true });
    const installed = installRepoSkill(cwd, 'zonoid-orchestrator', 'codex');
    const skillPath = path.join(cwd, '.codex', 'skills', 'zonoid-orchestrator', 'SKILL.md');
    ok('installRepoSkill installs zonoid-orchestrator into client .codex/skills', installed && fs.existsSync(skillPath));
    const text = fs.readFileSync(skillPath, 'utf8');
    ok('repo skill points to client adapter mappings',
      text.includes('client-adapters.md'));
    const adapterPath = path.join(cwd, '.codex', 'skills', 'zonoid-orchestrator', 'references', 'client-adapters.md');
    const adapterText = fs.readFileSync(adapterPath, 'utf8');
    ok('codex repo skill adapter reference documents create_task file-drop task minting',
      adapterText.includes('create_task') && adapterText.includes('codex/<id>'));

    const before = fs.readFileSync(skillPath, 'utf8');
    const second = installRepoSkill(cwd, 'zonoid-orchestrator', 'codex');
    const after = fs.readFileSync(skillPath, 'utf8');
    ok('installRepoSkill is idempotent when repo skill already exists', second && before === after);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ── Client-repo skill install: OpenCode guidance belongs in target repo ──────
// Mirrors the Codex block above but asserts the .opencode/skills destination
// uses the canonical skill name.
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-opencode-skill-'));
  try {
    const cwd = path.join(base, 'client-repo')
    fs.mkdirSync(cwd, { recursive: true })
    const installed = installRepoSkill(cwd, 'zonoid-orchestrator', 'opencode')
    const skillPath = path.join(cwd, '.opencode', 'skills', 'zonoid-orchestrator', 'SKILL.md')
    ok('installRepoSkill installs zonoid-orchestrator into client .opencode/skills',
      installed && fs.existsSync(skillPath))
    ok('installRepoSkill opencode does NOT touch .codex/skills',
      !fs.existsSync(path.join(cwd, '.codex', 'skills')))
    const text = fs.readFileSync(skillPath, 'utf8')
    ok('opencode repo skill points to client adapter mappings',
      text.includes('client-adapters.md'))
    const adapterPath = path.join(cwd, '.opencode', 'skills', 'zonoid-orchestrator', 'references', 'client-adapters.md')
    const adapterText = fs.readFileSync(adapterPath, 'utf8')
    ok('opencode repo skill adapter reference documents task_create file-drop task minting',
      adapterText.includes('task_create') && adapterText.includes('opencode/<id>'))
    ok('opencode repo skill surfaces the dashboard URL', text.includes('localhost:8787/graph'))

    // installOpencodeRepoSkills() wrapper hits the same path.
    const cwd2 = path.join(base, 'client-repo-2')
    fs.mkdirSync(cwd2, { recursive: true })
    const installed2 = installOpencodeRepoSkills(cwd2)
    const skillPath2 = path.join(cwd2, '.opencode', 'skills', 'zonoid-orchestrator', 'SKILL.md')
    ok('installOpencodeRepoSkills installs the opencode repo skill', installed2 && fs.existsSync(skillPath2))

    // Idempotent: a second install is byte-identical.
    const before = fs.readFileSync(skillPath, 'utf8')
    installRepoSkill(cwd, 'zonoid-orchestrator', 'opencode')
    const after = fs.readFileSync(skillPath, 'utf8')
    ok('installRepoSkill opencode is idempotent', before === after)
  } finally {
    fs.rmSync(base, { recursive: true, force: true })
  }
}

// ── OpenCode plugin dep pin: never 'latest' (opencode rewrites it to a broken @local) ──
{
  const v = opencodePluginDepVersion()
  ok('opencodePluginDepVersion never returns latest', v !== 'latest' && v !== '*')
  ok('opencodePluginDepVersion is a pinned range (~X.Y.0 when detected, else ^1.15.0)',
    /^(~\d+\.\d+\.0|\^\d+\.\d+\.\d+)$/.test(v))
}

// ── CDX-2: Claude + Codex coexistence in ONE repo ────────────────────────────
// Wire the claude MCP store (.mcp.json) then the codex MCP store
// (~/.codex/config.toml, injected path) and assert BOTH client identities
// survive AND a pre-existing user-added .mcp.json server is not dropped.
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-coexist-'));
  try {
    const cwd = path.join(base, 'repo');
    fs.mkdirSync(cwd, { recursive: true });
    const mcpPath = path.join(cwd, '.mcp.json');
    const codexToml = path.join(base, 'codex-config.toml');

    // Pre-existing user-added MCP server + unrelated config that MUST survive.
    fs.writeFileSync(mcpPath, JSON.stringify({
      mcpServers: { 'my-other-server': { command: 'node', args: ['other.js'] } },
    }, null, 2) + '\n');

    // 1) Claude wiring: MERGE orchestrator-graph into .mcp.json (no ORCH_CLIENT).
    writeMcp(cwd); // default orchClient=null == claude identity
    let mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    ok('coexist: .mcp.json keeps pre-existing user server after claude wiring',
      mcp.mcpServers['my-other-server'] && mcp.mcpServers['my-other-server'].args[0] === 'other.js');
    ok('coexist: .mcp.json gains orchestrator-graph (claude) after claude wiring',
      !!mcp.mcpServers['orchestrator-graph']);
    ok('coexist: claude orchestrator-graph has NO ORCH_CLIENT',
      !mcp.mcpServers['orchestrator-graph'].env || !mcp.mcpServers['orchestrator-graph'].env.ORCH_CLIENT);
    ok('coexist: claude entry args point at mcp-graph.js with forward slashes',
      /\/mcp-graph\.js$/.test(mcp.mcpServers['orchestrator-graph'].args[0]));
    ok('coexist: .mcp.json backed up on merge', fs.existsSync(mcpPath + '.bak'));

    // 2) Codex wiring: write orchestrator-graph into ~/.codex/config.toml (TOML),
    //    NOT .mcp.json. Inject the config path so no real ~/.codex is touched.
    writeCodexMcp(codexToml);
    ok('coexist: codex config.toml created', fs.existsSync(codexToml));
    const toml = fs.readFileSync(codexToml, 'utf8');
    ok('coexist: config.toml has [mcp_servers.orchestrator-graph] table',
      toml.includes('[mcp_servers.orchestrator-graph]'));
    ok('coexist: config.toml carries ORCH_CLIENT = "codex"',
      /\[mcp_servers\.orchestrator-graph\.env\][\s\S]*ORCH_CLIENT\s*=\s*"codex"/.test(toml));
    ok('coexist: config.toml command = "node"', /command\s*=\s*"node"/.test(toml));

    // 3) Codex wiring did NOT touch .mcp.json — Claude's identity + user server intact.
    mcp = JSON.parse(fs.readFileSync(mcpPath, 'utf8'));
    ok('coexist: BOTH survive — claude orchestrator-graph still in .mcp.json',
      !!mcp.mcpServers['orchestrator-graph'] &&
      (!mcp.mcpServers['orchestrator-graph'].env || !mcp.mcpServers['orchestrator-graph'].env.ORCH_CLIENT));
    ok('coexist: user server still present after codex wiring',
      !!mcp.mcpServers['my-other-server']);

    // 3b) .mcp.json merge is deterministic/idempotent: re-running writeMcp
    //     yields byte-identical content (the forward-slashed path is stable, so
    //     checkMcp would treat it as "looks correct" rather than rewriting).
    const before = fs.readFileSync(mcpPath, 'utf8');
    writeMcp(cwd);
    const after = fs.readFileSync(mcpPath, 'utf8');
    ok('coexist: .mcp.json merge is idempotent (stable content)', before === after);

    // 4) Idempotency: re-run codex wiring over existing config.toml → single table.
    //    Seed an unrelated [features] block to prove non-orch config is preserved.
    fs.writeFileSync(codexToml, '[features]\nhooks = true\n\n' + fs.readFileSync(codexToml, 'utf8'));
    writeCodexMcp(codexToml);
    const toml2 = fs.readFileSync(codexToml, 'utf8');
    const tableCount = (toml2.match(/^\[mcp_servers\.orchestrator-graph\]\s*$/gm) || []).length;
    ok('coexist: codex re-run is idempotent — exactly one orchestrator-graph table', tableCount === 1);
    ok('coexist: codex re-run preserves unrelated [features] config', toml2.includes('[features]'));
    ok('coexist: codex re-run still carries ORCH_CLIENT = "codex"', /ORCH_CLIENT\s*=\s*"codex"/.test(toml2));
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ── CDX-2: cursor identity injection still works on the merging writer ────────
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-cursor-mcp-'));
  try {
    const cwd = path.join(base, 'repo');
    fs.mkdirSync(cwd, { recursive: true });
    writeMcp(cwd, false, 'cursor');
    const mcp = JSON.parse(fs.readFileSync(path.join(cwd, '.mcp.json'), 'utf8'));
    ok('cursor wiring injects ORCH_CLIENT=cursor',
      mcp.mcpServers['orchestrator-graph'].env.ORCH_CLIENT === 'cursor');
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ── OpenCode native MCP config uses opencode.json, not .mcp.json ─────────────
{
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'zonoid-opencode-mcp-'));
  try {
    const cwd = path.join(base, 'repo');
    fs.mkdirSync(cwd, { recursive: true });
    const opencodePath = path.join(cwd, 'opencode.json');

    writeOpencodeMcp(cwd);
    let config = JSON.parse(fs.readFileSync(opencodePath, 'utf8'));
    let entry = config.mcp['orchestrator-graph'];
    ok('opencode wiring creates opencode.json', fs.existsSync(opencodePath));
    ok('opencode wiring does not create .mcp.json', !fs.existsSync(path.join(cwd, '.mcp.json')));
    ok('opencode wiring uses local command array',
      entry.type === 'local' &&
      entry.command[0] === 'node' &&
      /\/mcp-graph\.js$/.test(entry.command[1]));
    ok('opencode wiring enables orchestrator MCP', entry.enabled === true);
    ok('opencode wiring injects ORCH_CLIENT=opencode',
      entry.environment && entry.environment.ORCH_CLIENT === 'opencode');
    ok('opencode wiring explicitly registers the zonoid plugin (no auto-discovery in 1.15.x)',
      Array.isArray(config.plugin) && config.plugin.includes('./.opencode/plugins/zonoid.ts'));

    fs.writeFileSync(opencodePath, JSON.stringify({
      theme: 'system',
      mcp: {
        'other-server': { type: 'local', command: ['node', 'other.js'] },
      },
    }, null, 2) + '\n');
    writeOpencodeMcp(cwd);
    config = JSON.parse(fs.readFileSync(opencodePath, 'utf8'));
    entry = config.mcp['orchestrator-graph'];
    ok('opencode merge preserves unrelated top-level config', config.theme === 'system');
    ok('opencode merge preserves sibling MCP servers',
      config.mcp['other-server'] && config.mcp['other-server'].command[1] === 'other.js');
    ok('opencode merge backs up existing opencode.json', fs.existsSync(opencodePath + '.bak'));
    ok('opencode merge keeps ORCH_CLIENT=opencode',
      entry.environment && entry.environment.ORCH_CLIENT === 'opencode');

    const before = fs.readFileSync(opencodePath, 'utf8');
    writeOpencodeMcp(cwd);
    const after = fs.readFileSync(opencodePath, 'utf8');
    ok('opencode merge is idempotent (stable content)', before === after);
  } finally {
    fs.rmSync(base, { recursive: true, force: true });
  }
}

// ── CDX-2: orchestratorMcpEntry shape + stripCodexOrchTable preserves siblings ──
{
  const claudeEntry = orchestratorMcpEntry();
  ok('orchestratorMcpEntry: claude has no ORCH_CLIENT', !claudeEntry.env.ORCH_CLIENT);
  ok('orchestratorMcpEntry: stdio + node command',
    claudeEntry.type === 'stdio' && claudeEntry.command === 'node');
  const codexEntry = orchestratorMcpEntry('codex');
  ok('orchestratorMcpEntry: codex injects ORCH_CLIENT', codexEntry.env.ORCH_CLIENT === 'codex');
  const opencodeEntry = opencodeMcpEntry();
  ok('opencodeMcpEntry: native local command array',
    opencodeEntry.type === 'local' && opencodeEntry.command[0] === 'node');
  ok('opencodeMcpEntry: environment injects ORCH_CLIENT', opencodeEntry.environment.ORCH_CLIENT === 'opencode');
  const opencodeRel = opencodeMcpEntry(INSTALL_DIR);
  ok('opencodeMcpEntry: relative mcp-graph.js when cwd is install dir (portable)', opencodeRel.command[1] === 'mcp-graph.js');
  const opencodeAbs = opencodeMcpEntry('/some/other/repo');
  ok('opencodeMcpEntry: absolute mcp-graph.js for out-of-workspace install', /\/mcp-graph\.js$/.test(opencodeAbs.command[1]) && opencodeAbs.command[1] !== 'mcp-graph.js');

  // stripCodexOrchTable must drop ONLY the orchestrator-graph table + its .env
  // subtable, preserving a sibling [mcp_servers.other] entirely.
  const doc = [
    '[mcp_servers.other]',
    'command = "node"',
    'args = ["x.js"]',
    '',
    '[mcp_servers.orchestrator-graph]',
    'command = "node"',
    'args = ["old.js"]',
    '',
    '[mcp_servers.orchestrator-graph.env]',
    'ORCH_CLIENT = "codex"',
    '',
    '[features]',
    'hooks = true',
  ].join('\n');
  const stripped = stripCodexOrchTable(doc);
  ok('stripCodexOrchTable: removes orchestrator-graph table', !stripped.includes('orchestrator-graph'));
  ok('stripCodexOrchTable: keeps sibling [mcp_servers.other]', stripped.includes('[mcp_servers.other]'));
  ok('stripCodexOrchTable: keeps sibling server args', stripped.includes('args = ["x.js"]'));
  ok('stripCodexOrchTable: keeps unrelated [features]', stripped.includes('[features]'));
}

// ── graphAutocommitHookScript ────────────────────────────────────────────────
{
  const script = graphAutocommitHookScript();
  ok('graphAutocommitHookScript: ORCH_GRAPH_AUTOCOMMIT guard present',
    script.includes('[ "${ORCH_GRAPH_AUTOCOMMIT}" = "1" ]'));
  ok('graphAutocommitHookScript: find .graph -name "*.jsonl" present',
    script.includes('find .graph -name "*.jsonl"'));
  ok('graphAutocommitHookScript: -newer flag present',
    script.includes('-newer'));
  ok('graphAutocommitHookScript: git commit --no-verify present',
    script.includes('git commit --no-verify'));
}

// ── mergeGraphAutocommitFlag ─────────────────────────────────────────────────
// (a) enable=true → env.ORCH_GRAPH_AUTOCOMMIT === "1"
{
  const base = { env: { OTHER: 'keep' }, someTopLevel: 'value' };
  const result = mergeGraphAutocommitFlag(base, true);
  ok('mergeGraphAutocommitFlag enable=true: flag is "1"', result.env.ORCH_GRAPH_AUTOCOMMIT === '1');
  ok('mergeGraphAutocommitFlag enable=true: preserves OTHER env key', result.env.OTHER === 'keep');
  ok('mergeGraphAutocommitFlag enable=true: preserves top-level settings', result.someTopLevel === 'value');
  // Ensure input was not mutated
  ok('mergeGraphAutocommitFlag enable=true: input not mutated', !('ORCH_GRAPH_AUTOCOMMIT' in base.env));
}

// (b) enable=false + key absent → "0"
{
  const base = { env: { OTHER: 'keep' }, topKey: 42 };
  const result = mergeGraphAutocommitFlag(base, false);
  ok('mergeGraphAutocommitFlag enable=false absent: flag is "0"', result.env.ORCH_GRAPH_AUTOCOMMIT === '0');
  ok('mergeGraphAutocommitFlag enable=false absent: preserves OTHER', result.env.OTHER === 'keep');
  ok('mergeGraphAutocommitFlag enable=false absent: preserves topKey', result.topKey === 42);
}

// (c) enable=false + existing "1" → STILL "1" (no downgrade)
{
  const base = { env: { ORCH_GRAPH_AUTOCOMMIT: '1', OTHER: 'keep' } };
  const result = mergeGraphAutocommitFlag(base, false);
  ok('mergeGraphAutocommitFlag no-downgrade: existing "1" stays "1"', result.env.ORCH_GRAPH_AUTOCOMMIT === '1');
  ok('mergeGraphAutocommitFlag no-downgrade: preserves OTHER', result.env.OTHER === 'keep');
}

// (d) env absent → created with flag
{
  const base = { topOnly: 'yes' };
  const result = mergeGraphAutocommitFlag(base, true);
  ok('mergeGraphAutocommitFlag no-env: env created', result.env && result.env.ORCH_GRAPH_AUTOCOMMIT === '1');
  ok('mergeGraphAutocommitFlag no-env: topOnly preserved', result.topOnly === 'yes');
}

// ── parseInitArgs: --graph-autocommit ───────────────────────────────────────
{
  const withFlag = parseInitArgs(['node', 'zonoid', 'init', '--graph-autocommit']);
  ok('parseInitArgs --graph-autocommit: enableGraphAutocommit=true', withFlag.enableGraphAutocommit === true);

  const withoutFlag = parseInitArgs(['node', 'zonoid', 'init']);
  ok('parseInitArgs no --graph-autocommit: enableGraphAutocommit is falsy',
    !withoutFlag.enableGraphAutocommit);

  // Existing --harness and --service parsing unaffected
  const combined = parseInitArgs(['node', 'zonoid', 'init', '--harness', 'cursor', '--service', '--graph-autocommit']);
  ok('parseInitArgs combined: harness still parsed', combined.harness === 'cursor');
  ok('parseInitArgs combined: service still parsed', combined.service === true);
  ok('parseInitArgs combined: enableGraphAutocommit=true', combined.enableGraphAutocommit === true);
}

process.exit(failed ? 1 : 0);
