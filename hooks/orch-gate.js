#!/usr/bin/env node
'use strict';
// PreToolUse(Write|Edit) GATE: enforce task-claim discipline for substantive inline edits.
// Cross-platform Node port of orch-gate.sh (no bash/jq/curl dependency).
//
// Subagents: zero-tolerance — require a valid active claim before any non-exempt Write/Edit.
// Main/dispatcher sessions: claim via a worker, or use 1 trivial patch/turn while a worker runs.
// Default-on: a conversation opts out with 'orch off' (sessions/<id>.off). Fail-open if the daemon
// is unreachable — we deny only on a definitive "no claim for this session".
const k = require('./lib/hookkit');

(async () => {
  if (k.gateOff()) k.allow();
  const input = await k.readInput();
  const ti = input.tool_input || {};
  const fp = k.slash(ti.file_path || '');

  // ── Path allow-list (first match wins, mirroring the bash `case`) ──────────
  // Harness plumbing that is NOT substantive work. Orchestrator SOURCE is deliberately NOT exempt.
  if (fp) {
    if (/\/\.claude\/projects\/.*\/memory\//.test(fp)) k.allow();        // auto-memory store
    if (fp.endsWith('/.claude/settings.json') || fp.endsWith('/.claude/settings.local.json')) k.allow();
    if (fp.endsWith('/.claude/keybindings.json') || fp.endsWith('/.claude/launch.json')) k.allow();
    if (fp.endsWith('/.mcp.json')) k.allow();                            // MCP server config
    if (fp.endsWith('/CLAUDE.md')) k.allow();                            // instruction file
    if (fp.startsWith('/tmp/') || fp.startsWith('/private/tmp/')) {
      /* /tmp is NOT exempt: workers must use claimed worktrees — fall through */
    } else if (fp.includes('/.claude/orchestrator/tasks/')) {
      k.allow();                                                         // file-drop task mint
    } else if (fp.includes('/.claude/tasks/')) {
      k.allow();                                                         // native TaskCreate files
    } else if (fp.includes('/.claude/orchestrator/')) {
      /* orchestrator source: never exempt — fall through to claim check */
    } else if (fp.includes('/scratch/')) {
      k.allow();                                                         // workspace scratch
    } else if (fp.endsWith('.log') || fp.includes('/logs/')) {
      k.allow();                                                         // log writes
    }
  }

  const sid = input.session_id || '';
  if (!sid) k.allow();                       // no session id -> can't correlate; don't block
  if (k.isOff(sid)) k.allow();               // orchestrator disabled for this conversation

  const resp = await k.getJson(`/active-claim?session=${encodeURIComponent(sid)}`, 600);
  if (!resp) k.allow();                       // daemon unreachable -> fail open

  if (resp.claimed === true) {
    // A session may hold several claims (different worktrees). Allow if ANY claim's worktree is an
    // ancestor of the target file (or the tool has no file path).
    const claims = Array.isArray(resp.claims) ? resp.claims : [];
    let anyWorktree = false, matched = false, mismatchBranch = '';
    for (const c of claims) {
      const key = c && c.key;
      if (!key) continue;
      const detail = await k.getJson(`/task/detail?key=${encodeURIComponent(key)}`, 600);
      const branch = detail && detail.task && detail.task.git && detail.task.git.branch;
      const wt = detail && detail.task && detail.task.git && detail.task.git.worktree;
      if (branch) {
        anyWorktree = true;
        mismatchBranch = branch;
        if (!fp || k.isUnder(fp, wt)) { matched = true; break; }
      }
    }
    if (anyWorktree && !matched) {
      k.deny(`orch-gate: task has a registered worktree (${mismatchBranch}) — writes must happen inside the worktree path, not at ${fp}. Use the path returned by branch_task.`);
    }
    k.allow();                                // an in_progress task is claimed -> allow
  }

  // No active claim. Subagent or main/driving session?
  const sinfo = await k.getJson(`/session-info?session=${encodeURIComponent(sid)}`, 600);
  const isSub = sinfo && sinfo.is_subagent;
  if (isSub === true) {
    k.deny('orch-gate: no task claimed. Worker subagents must call branch_task then start_task before editing. To create new tasks use the native TaskCreate tool (not an MCP endpoint).');
  }

  // Main/driving session (or unknown): try 1 trivial patch/turn if workers are in flight.
  const patch = ti.new_string != null ? ti.new_string : (ti.content != null ? ti.content : '');
  const t = await k.tryTrivialMainAllow(sid, patch);
  if (t.ok) {
    await k.reportDispatcherEdit(sid, Buffer.byteLength(patch, 'utf8'), fp, t.attribution);
    k.allow();
  }
  k.deny(k.mainSessionDenyMessage(t.denyReason));
})().catch(() => process.exit(0));   // never brick edits on an unexpected hook error -> fail open
