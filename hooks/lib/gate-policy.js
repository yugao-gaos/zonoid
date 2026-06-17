'use strict';

const k = require('./hookkit');

function isPathExempt(p) {
  const s = k.normalizePath(p);
  if (!s) return false;
  if (s === '/dev/null' || s === '/dev/stderr' || s === '/dev/stdout') return true;
  if (/\/\.claude\/projects\/.*\/memory\//.test(s)) return true;
  if (s.endsWith('/.claude/settings.json') || s.endsWith('/.claude/settings.local.json')) return true;
  if (s.endsWith('/.claude/keybindings.json') || s.endsWith('/.claude/launch.json')) return true;
  if (s.endsWith('/.mcp.json')) return true;
  if (s.endsWith('/CLAUDE.md')) return true;
  if (s.includes('/.claude/orchestrator/tasks/')) return true;
  if (s.includes('/.claude/tasks/')) return true;
  if (s.includes('/scratch/')) return true;
  if (/\/logs\/.*\.log$/.test(s)) return true;
  return false;
}

function applyPatchText(ti) {
  if (!ti || typeof ti !== 'object') return '';
  const direct = ti.input ?? ti.patch ?? ti.patch_text ?? ti.diff ?? ti.content ?? ti.text;
  if (typeof direct === 'string' && direct.includes('*** ')) return direct;
  if (Array.isArray(ti.changes)) {
    const joined = ti.changes
      .map((c) => (typeof c === 'string' ? c : (c && (c.patch ?? c.diff ?? c.content)) || ''))
      .join('\n');
    if (joined.includes('*** ')) return joined;
  }
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
  while ((m = re.exec(text)) !== null) {
    if (m[1]) out.push(k.slash(m[1].trim()));
  }
  return out;
}

function writeEditTargets(input) {
  const ti = input.tool_input || {};
  const fp = k.slash(ti.file_path || '');
  const toolName = String(input.tool_name || '');
  const patchPaths = (toolName === 'apply_patch' || !fp) ? applyPatchPaths(ti) : [];
  return fp ? [fp, ...patchPaths] : patchPaths.slice();
}

function resolveTarget(t, wt) {
  const s = k.slash(t);
  const isAbs = s.startsWith('/') || /^[A-Za-z]:\//.test(s);
  return k.normalizePath(isAbs ? s : `${k.slash(wt).replace(/\/+$/, '')}/${s}`);
}

function firstOutsideWorktree(targets, wt) {
  for (const t of targets || []) {
    if (!t || isPathExempt(t)) continue;
    if (!(wt && k.isUnder(resolveTarget(t, wt), wt))) return t;
  }
  return '';
}

function allTargetsExempt(targets) {
  return Array.isArray(targets) && targets.length > 0 && targets.every(isPathExempt);
}

function isGitCommandExempt(cmd) {
  const gitVerbs = /(^|[;&|]|&&|\|\|)\s*git\s+(-C\s+\S+\s+)?(commit|merge|add|push|pull|fetch|branch|tag|worktree|rebase|cherry-pick|log|status|diff|show|rev-parse|describe|remote)\b/;
  const gitMutators = /\bgit\s+(-C\s+\S+\s+)?(checkout|restore|reset|clean|rm|stash)\b/;
  return gitVerbs.test(cmd) && !gitMutators.test(cmd);
}

function isLocalDaemonCommand(cmd, port) {
  const reLocal = new RegExp(`\\b(curl|wget)\\b.*(localhost|127\\.0\\.0\\.1):${port}(/|$)`);
  return reLocal.test(cmd);
}

function hasBashWritePattern(cmd) {
  const cmdRedir = cmd.replace(/'[^']*'/g, 'Q').replace(/"[^"]*"/g, 'Q');
  return (
    /(^|[^A-Za-z0-9._@-])(>>?)\s*[^/\s&0-9]/.test(cmdRedir) ||
    /(>>?)\s*\/(?!dev\/null)/.test(cmdRedir) ||
    /\btee\b/.test(cmd) ||
    /open\s*\(.*['"]([wWaA]|[wWaA]b)['"]|\.write(_text|_bytes)?\s*\(|\.touch\s*\(/.test(cmd) ||
    /\b(cp|mv|rsync|install)\b/.test(cmd) ||
    /\bdd\b.*\bof=/.test(cmd) ||
    /\bsed\b.*-i/.test(cmd)
  );
}

function bashWriteTargets(cmd) {
  const cmdNoComment = String(cmd || '').replace(/[ \t]#.*$/m, '');
  const targets = [];
  for (const m of cmdNoComment.matchAll(/(>>?)\s*(\S+)/g)) {
    if (m[2]) targets.push(m[2]);
  }
  if (/\b(cp|mv|rsync|install)\b/.test(cmdNoComment)) {
    const toks = cmdNoComment.split(/\s+/).filter((t) => t && !t.startsWith('-'));
    if (toks.length) targets.push(toks[toks.length - 1]);
  }
  const dd = cmdNoComment.match(/\bof=(\S+)/);
  if (dd) targets.push(dd[1]);
  return targets;
}

module.exports = {
  isPathExempt,
  applyPatchText,
  applyPatchPaths,
  writeEditTargets,
  resolveTarget,
  firstOutsideWorktree,
  allTargetsExempt,
  isGitCommandExempt,
  isLocalDaemonCommand,
  hasBashWritePattern,
  bashWriteTargets,
};
