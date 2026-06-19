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
  if (s.includes('/.zonoid/tasks/')) return true;
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

function firstOutsideAnyWorktree(targets, worktrees) {
  const list = Array.isArray(worktrees) ? worktrees : [];
  for (const t of targets || []) {
    if (!t || isPathExempt(t)) continue;
    const inside = list.some((wt) => wt && k.isUnder(resolveTarget(t, wt), wt));
    if (!inside) return t;
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

function tokenizeShellCommand(s) {
  const out = [];
  let cur = '';
  let quote = '';
  const push = () => {
    if (cur) {
      out.push(cur);
      cur = '';
    }
  };
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (quote) {
      if (ch === quote) quote = '';
      else cur += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      push();
      continue;
    }
    if (ch === ';') {
      push();
      out.push(ch);
      continue;
    }
    if (ch === '|' || ch === '&') {
      push();
      if (s[i + 1] === ch) {
        out.push(ch + ch);
        i++;
      } else {
        out.push(ch);
      }
      continue;
    }
    cur += ch;
  }
  push();
  return out;
}

function cleanToken(t) {
  return String(t || '').replace(/^[({]+/, '').replace(/[),;]+$/, '');
}

function isCommandBoundary(t) {
  return t === ';' || t === '|' || t === '&&' || t === '||' || t === '&';
}

function isRedirectToken(t) {
  return /^[0-9]*>>?/.test(String(t || '')) || /^[0-9]*\*?>/.test(String(t || ''));
}

function isAssignmentToken(t) {
  return /^[A-Za-z_][A-Za-z0-9_]*=/.test(String(t || ''));
}

const COMMAND_WRAPPERS = new Set(['sudo', 'command', 'builtin', 'env', 'noglob']);

function shellCommandIndices(toks) {
  const out = [];
  let expect = true;
  for (let i = 0; i < toks.length; i++) {
    if (isCommandBoundary(toks[i])) {
      expect = true;
      continue;
    }
    if (!expect) continue;
    let j = i;
    while (j < toks.length && !isCommandBoundary(toks[j])) {
      const candidate = cleanToken(toks[j]).toLowerCase();
      if (COMMAND_WRAPPERS.has(candidate) || isAssignmentToken(candidate)) {
        j++;
        continue;
      }
      out.push(j);
      break;
    }
    expect = false;
  }
  return out;
}

function commandName(tok) {
  const raw = cleanToken(tok).toLowerCase();
  return raw.split(/[\\/]/).pop();
}

function hasShellCommand(cmdNoComment, names) {
  const toks = tokenizeShellCommand(cmdNoComment);
  return shellCommandIndices(toks).some((i) => names.has(commandName(toks[i])));
}

const PS_PATH_OPTIONS = new Set(['-path', '-literalpath', '-filepath', '-destination']);
const PS_SKIP_VALUE_OPTIONS = new Set([
  '-value', '-itemtype', '-type', '-encoding', '-filter', '-include', '-exclude',
  '-credential', '-stream', '-name',
]);
const PS_PATH_COMMANDS = new Set([
  'set-content', 'add-content', 'out-file', 'new-item', 'remove-item', 'clear-content',
  'sc', 'ac', 'ni', 'rm', 'del', 'erase', 'rd', 'ri', 'rmdir',
]);
const PS_DEST_COMMANDS = new Set(['copy-item', 'move-item', 'copy', 'cpi', 'move', 'mi']);
const PS_WRITE_COMMANDS = new Set([...PS_PATH_COMMANDS, ...PS_DEST_COMMANDS]);

function isPowerShellWriteCommand(t) {
  return PS_WRITE_COMMANDS.has(cleanToken(t).toLowerCase());
}

function collectPowerShellTargets(cmdNoComment) {
  const toks = tokenizeShellCommand(cmdNoComment);
  const targets = [];
  for (let i = 0; i < toks.length; i++) {
    const cmd = cleanToken(toks[i]).toLowerCase();
    if (!PS_WRITE_COMMANDS.has(cmd)) continue;

    const positional = [];
    for (let j = i + 1; j < toks.length; j++) {
      const raw = toks[j];
      if (isCommandBoundary(raw)) break;
      const tok = cleanToken(raw);
      const lower = tok.toLowerCase();
      const colon = lower.match(/^(-[a-z]+):(.*)$/);
      if (colon) {
        if (PS_PATH_OPTIONS.has(colon[1])) {
          const value = tok.slice(colon[1].length + 1);
          if (value) targets.push(value);
        }
        continue;
      }
      if (PS_PATH_OPTIONS.has(lower)) {
        if (j + 1 < toks.length && !isCommandBoundary(toks[j + 1])) {
          targets.push(cleanToken(toks[++j]));
        }
        continue;
      }
      if (PS_SKIP_VALUE_OPTIONS.has(lower)) {
        if (j + 1 < toks.length && !isCommandBoundary(toks[j + 1])) j++;
        continue;
      }
      if (lower.startsWith('-') || /^[0-9]*>>?$/.test(lower)) continue;
      positional.push(tok);
    }
    if (PS_DEST_COMMANDS.has(cmd)) {
      if (positional.length >= 2) targets.push(positional[positional.length - 1]);
    } else if (positional.length) {
      targets.push(positional[0]);
    }
  }
  return targets;
}

function hasBashWritePattern(cmd) {
  const cmdRedir = cmd.replace(/'[^']*'/g, 'Q').replace(/"[^"]*"/g, 'Q');
  const cmdNoComment = String(cmd || '').replace(/[ \t]#.*$/m, '');
  return (
    /(^|[^A-Za-z0-9._@-])(>>?)\s*[^/\s&0-9]/.test(cmdRedir) ||
    /(>>?)\s*\/(?!dev\/null)/.test(cmdRedir) ||
    hasShellCommand(cmdNoComment, new Set(['tee'])) ||
    /open\s*\(.*['"]([wWaA]|[wWaA]b)['"]|\.write(_text|_bytes)?\s*\(|\.touch\s*\(/.test(cmd) ||
    hasShellCommand(cmdNoComment, new Set(['cp', 'mv', 'rsync', 'install'])) ||
    /\bdd\b.*\bof=/.test(cmd) ||
    (hasShellCommand(cmdNoComment, new Set(['sed'])) && /(^|\s)-i(\s|[A-Za-z0-9._-])/.test(cmdNoComment)) ||
    tokenizeShellCommand(cmd).some(isPowerShellWriteCommand)
  );
}

function collectCommandDestTargets(cmdNoComment, names) {
  const toks = tokenizeShellCommand(cmdNoComment);
  const targets = [];
  for (const idx of shellCommandIndices(toks)) {
    if (!names.has(commandName(toks[idx]))) continue;
    const positional = [];
    for (let j = idx + 1; j < toks.length; j++) {
      const raw = toks[j];
      if (isCommandBoundary(raw)) break;
      const tok = cleanToken(raw);
      const lower = tok.toLowerCase();
      if (isRedirectToken(lower)) {
        if (/^[0-9]*\*?>?$/.test(lower) && j + 1 < toks.length && !isCommandBoundary(toks[j + 1])) j++;
        continue;
      }
      if (lower === '--') continue;
      if (lower.startsWith('-')) continue;
      positional.push(tok);
    }
    if (positional.length) targets.push(positional[positional.length - 1]);
  }
  return targets;
}

function collectTeeTargets(cmdNoComment) {
  const toks = tokenizeShellCommand(cmdNoComment);
  const targets = [];
  for (const idx of shellCommandIndices(toks)) {
    if (commandName(toks[idx]) !== 'tee') continue;
    for (let j = idx + 1; j < toks.length; j++) {
      const raw = toks[j];
      if (isCommandBoundary(raw)) break;
      const tok = cleanToken(raw);
      const lower = tok.toLowerCase();
      if (isRedirectToken(lower)) {
        if (/^[0-9]*\*?>?$/.test(lower) && j + 1 < toks.length && !isCommandBoundary(toks[j + 1])) j++;
        continue;
      }
      if (lower === '--' || lower.startsWith('-')) continue;
      targets.push(tok);
    }
  }
  return targets;
}

function looksLikeSedScript(tok) {
  return /^[a-z](.|$)/i.test(String(tok || '')) || String(tok || '').includes('/');
}

function collectSedTargets(cmdNoComment) {
  const toks = tokenizeShellCommand(cmdNoComment);
  const targets = [];
  for (const idx of shellCommandIndices(toks)) {
    if (commandName(toks[idx]) !== 'sed') continue;
    let inPlace = false;
    let scriptConsumed = false;
    let skipNext = null;
    for (let j = idx + 1; j < toks.length; j++) {
      const raw = toks[j];
      if (isCommandBoundary(raw)) break;
      const tok = cleanToken(raw);
      const lower = tok.toLowerCase();
      if (isRedirectToken(lower)) {
        if (/^[0-9]*\*?>?$/.test(lower) && j + 1 < toks.length && !isCommandBoundary(toks[j + 1])) j++;
        continue;
      }
      if (skipNext) {
        if (skipNext === 'script') scriptConsumed = true;
        skipNext = null;
        continue;
      }
      if (lower === '-i' || lower.startsWith('-i')) {
        inPlace = true;
        if (lower === '-i' && j + 1 < toks.length) {
          const next = cleanToken(toks[j + 1]);
          if (next.startsWith('.') && !looksLikeSedScript(next)) j++;
        }
        continue;
      }
      if (lower === '-e') { skipNext = 'script'; continue; }
      if (lower === '-f') { skipNext = 'file'; continue; }
      if (lower.startsWith('-')) continue;
      if (!inPlace) continue;
      if (!scriptConsumed) {
        scriptConsumed = true;
        continue;
      }
      targets.push(tok);
    }
  }
  return targets;
}

function collectPythonTargets(cmd) {
  const targets = [];
  const pathCall = /\b(?:pathlib\.)?Path\s*\(\s*(['"])(.*?)\1\s*\)\s*\.\s*(?:write_text|write_bytes|touch)\s*\(/g;
  for (const m of String(cmd || '').matchAll(pathCall)) {
    if (m[2]) targets.push(m[2]);
  }
  const openCall = /\bopen\s*\(\s*(['"])(.*?)\1\s*,\s*(['"])([^'"]*[waWA][^'"]*)\3/g;
  for (const m of String(cmd || '').matchAll(openCall)) {
    if (m[2]) targets.push(m[2]);
  }
  return targets;
}

function bashWriteTargets(cmd) {
  const cmdNoComment = String(cmd || '').replace(/[ \t]#.*$/m, '');
  const targets = [];
  for (const m of cmdNoComment.matchAll(/(>>?)\s*(\S+)/g)) {
    if (m[2]) targets.push(m[2]);
  }
  targets.push(...collectCommandDestTargets(cmdNoComment, new Set(['cp', 'mv', 'rsync', 'install'])));
  targets.push(...collectTeeTargets(cmdNoComment));
  targets.push(...collectSedTargets(cmdNoComment));
  targets.push(...collectPythonTargets(cmdNoComment));
  const dd = cmdNoComment.match(/\bof=(\S+)/);
  if (dd) targets.push(dd[1]);
  targets.push(...collectPowerShellTargets(cmdNoComment));
  return targets;
}

module.exports = {
  isPathExempt,
  applyPatchText,
  applyPatchPaths,
  writeEditTargets,
  resolveTarget,
  firstOutsideWorktree,
  firstOutsideAnyWorktree,
  allTargetsExempt,
  isGitCommandExempt,
  isLocalDaemonCommand,
  tokenizeShellCommand,
  hasBashWritePattern,
  bashWriteTargets,
};
