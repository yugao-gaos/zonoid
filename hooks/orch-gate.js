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

// ── Codex apply_patch path extraction ────────────────────────────────────────
// Codex's apply_patch tool does NOT populate tool_input.file_path — the target path(s) live inside
// the patch envelope under a field whose name varies by Codex build (input / patch / changes / …).
// We mirror the multi-key fallback used by packages/opencode-plugin/lib/gate.js and, as a last
// resort, scan every string-valued tool_input field for the patch body. Inside the envelope each
// touched file is announced by a header line:
//   *** Add File: <path> | *** Update File: <path> | *** Delete File: <path>
// plus Codex's rename form `*** Move to: <path>` (the new path on an Update). A single apply_patch
// may touch MANY files — we return EVERY path so the caller can confine-check each one.
function applyPatchText(ti) {
  if (!ti || typeof ti !== 'object') return '';
  // Direct string carriers (most Codex builds): tool_input.input or tool_input.patch.
  const direct = ti.input ?? ti.patch ?? ti.patch_text ?? ti.diff ?? ti.content ?? ti.text;
  if (typeof direct === 'string' && direct.includes('*** ')) return direct;
  // changes[] array carrier: join any string members / their patch fields.
  if (Array.isArray(ti.changes)) {
    const joined = ti.changes
      .map((c) => (typeof c === 'string' ? c : (c && (c.patch ?? c.diff ?? c.content)) || ''))
      .join('\n');
    if (joined.includes('*** ')) return joined;
  }
  // Last resort: any string field on tool_input that looks like an apply_patch envelope.
  for (const v of Object.values(ti)) {
    if (typeof v === 'string' && /\*\*\* (Add|Update|Delete) File:|\*\*\* Begin Patch/.test(v)) return v;
  }
  return '';
}
function applyPatchPaths(ti) {
  const text = applyPatchText(ti);
  if (!text) return [];
  const out = [];
  const re = /^\*\*\*\s+(?:Add File|Update File|Delete File|Move to):\s*(.+?)\s*$/gm;
  let m;
  while ((m = re.exec(text)) !== null) { if (m[1]) out.push(k.slash(m[1].trim())); }
  return out;
}
// Resolve a patch target to an absolute, slash-normalized path. apply_patch headers may carry a
// path relative to the worker's cwd (== the claim worktree); absolute paths (POSIX `/…` or Windows
// `C:/…`) pass through. normalizePath collapses any `..` so an escape can't hide inside the prefix.
function resolveTarget(t, wt) {
  const s = k.slash(t);
  const isAbs = s.startsWith('/') || /^[A-Za-z]:\//.test(s);
  return k.normalizePath(isAbs ? s : `${k.slash(wt).replace(/\/+$/, '')}/${s}`);
}

(async () => {
  if (k.gateOff()) k.allow();
  const input = await k.readInput();
  const ti = input.tool_input || {};
  const fp = k.slash(ti.file_path || '');
  // Codex apply_patch carries its target path(s) inside the patch body, not in file_path. Extract
  // them so the worktree-confinement check below covers apply_patch the same as Write/Edit.
  const toolName = String(input.tool_name || '');
  const patchPaths = (toolName === 'apply_patch' || !fp) ? applyPatchPaths(ti) : [];

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
    // ancestor of EVERY target path (or the tool has no file path). Targets = the Write/Edit
    // file_path PLUS every path an apply_patch envelope touches — apply_patch may write multiple
    // files in one call, and if ANY lands outside the worktree the confinement check must block.
    const targets = fp ? [fp, ...patchPaths] : patchPaths.slice();
    const claims = Array.isArray(resp.claims) ? resp.claims : [];
    let anyWorktree = false, matched = false, mismatchBranch = '', offending = '';
    for (const c of claims) {
      const key = c && c.key;
      if (!key) continue;
      const detail = await k.getJson(`/task/detail?key=${encodeURIComponent(key)}`, 600);
      const branch = detail && detail.task && detail.task.git && detail.task.git.branch;
      const wt = detail && detail.task && detail.task.git && detail.task.git.worktree;
      if (branch) {
        anyWorktree = true;
        mismatchBranch = branch;
        // Match this claim only if every target is inside its worktree (empty targets => non-file
        // tool => allow). Require a non-empty wt so an empty worktree can't degrade isUnder to a
        // universal match and silently allow out-of-worktree writes.
        if (targets.length === 0) { matched = true; break; }
        // apply_patch paths are often RELATIVE to the worker's cwd (== the worktree when claimed);
        // resolve a non-absolute target against this worktree before the ancestor test. An absolute
        // out-of-tree path stays absolute (blocked); a `../escape` resolves outside wt (blocked).
        const outside = targets.find((t) => !(wt && k.isUnder(resolveTarget(t, wt), wt)));
        if (!outside) { matched = true; break; }
        offending = outside;
      }
    }
    if (anyWorktree && !matched) {
      k.deny(`orch-gate: task has a registered worktree (${mismatchBranch}) — writes must happen inside the worktree path, not at ${offending || fp || '(apply_patch)'}. Use the path returned by branch_task.`);
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
