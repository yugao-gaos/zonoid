// Cursor IDE transcript JSONL discovery and token parsing for the harness adapter.
// On-disk layout (observed Jun 2026):
//   ~/.cursor/projects/<encoded-workspace>/agent-transcripts/<conversation-id>/<conversation-id>.jsonl
//   Subagent transcripts: .../<conversation-id>/subagents/<subagent-id>.jsonl
// Workspace encoding: absolute path with leading "/" stripped, "/" → "-" (e.g.
//   /Users/x/proj → Users-x-proj). Differs from Claude's encodeWorkspace (also maps "." → "-").
'use strict';
const fs = require('fs');
const path = require('path');
const os = require('os');
const {
  stripInjected, CHARS_PER_TOKEN, AUTOMATION_MARKERS,
} = require('./human-input');

const CURSOR_PROJECTS = path.join(os.homedir(), '.cursor', 'projects');

function encodeWorkspace(absPath) {
  // Normalize the string directly — do NOT use path.resolve(): on Windows it rewrites a
  // unix-style input ('/Users/x') into a drive path ('C:\Users\x'), corrupting the key.
  return String(absPath || '')
    .replace(/^[a-zA-Z]:/, '')   // drop Windows drive letter (D: → '')
    .replace(/^[\\/]+/, '')      // strip leading separator(s) (unix '/' or win '\')
    .replace(/[\\/]/g, '-');     // remaining separators → '-'
}

function projectDir(ws) {
  if (!ws) return null;
  return path.join(CURSOR_PROJECTS, encodeWorkspace(ws));
}

function transcriptsDir(projectDirPath) {
  return projectDirPath ? path.join(projectDirPath, 'agent-transcripts') : null;
}

// Strip Cursor-injected envelope tags; keep inner user_query text.
function stripCursorEnvelope(text) {
  let t = String(text || '');
  t = t.replace(/<timestamp>[\s\S]*?<\/timestamp>/g, '');
  t = t.replace(/<\/?user_query>/g, '');
  return t.trim();
}

function userRole(d) {
  return d.type || d.role || '';
}

function textParts(content) {
  if (typeof content === 'string') return [content];
  if (Array.isArray(content)) {
    return content.filter((c) => c && c.type === 'text').map((c) => c.text || '');
  }
  return null;
}

function countFile(file, since) {
  const r = { chars: 0, messages: 0, dropped: 0 };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return r; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (userRole(d) !== 'user' || d.isSidechain || d.isMeta) continue;
    if (since && ((d.timestamp || '').slice(0, 19) < since.slice(0, 19))) continue;
    const content = (d.message || {}).content;
    const texts = textParts(content);
    if (!texts) continue;
    if (Array.isArray(content) && content.some((c) => c && c.type === 'tool_result')) continue;
    const t = stripInjected(stripCursorEnvelope(texts.join('\n')));
    if (!t) continue;
    if (AUTOMATION_MARKERS.some((m) => t.includes(m))) { r.dropped++; continue; }
    r.chars += t.length;
    r.messages++;
  }
  return r;
}

function humanInputTokens(projectDirPath, opts = {}) {
  const since = opts.since || null;
  const out = { tokens: 0, chars: 0, messages: 0, dropped: 0, files: 0, since };
  if (!transcriptsDir(projectDirPath)) return out;
  for (const { path: fp } of listSessionTranscripts(projectDirPath)) {
    const r = countFile(fp, since);
    out.chars += r.chars; out.messages += r.messages; out.dropped += r.dropped; out.files++;
  }
  out.tokens = Math.round(out.chars / CHARS_PER_TOKEN);
  return out;
}

function harnessOverheadTokens(projectDirPath, opts = {}) {
  const since = opts.since || null;
  const by_category = { system_reminder: 0, tool_result: 0, command_blocks: 0, automation_messages: 0, orchestrator_suffix: 0 };
  let totalChars = 0;
  let files = 0;
  if (!transcriptsDir(projectDirPath)) {
    return { tokens: 0, chars: 0, by_category: Object.fromEntries(Object.keys(by_category).map((k) => [k, 0])), files: 0, since };
  }
  for (const { path: fp } of listSessionTranscripts(projectDirPath)) {
    files++;
    let raw;
    try { raw = fs.readFileSync(fp, 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (userRole(d) !== 'user') continue;
      if (since && ((d.timestamp || '').slice(0, 19) < since.slice(0, 19))) continue;
      const content = (d.message || {}).content;

      if (d.isSidechain || d.isMeta) {
        const texts = textParts(content) || [];
        const chars = texts.join('\n').length;
        by_category.automation_messages += chars;
        totalChars += chars;
        continue;
      }

      if (Array.isArray(content) && content.some((c) => c && c.type === 'tool_result')) {
        const chars = content.reduce((s, c) => {
          if (!c) return s;
          if (typeof c.content === 'string') return s + c.content.length;
          if (Array.isArray(c.content)) {
            return s + c.content.filter((x) => x && x.type === 'text').reduce((ss, x) => ss + (x.text || '').length, 0);
          }
          return s;
        }, 0);
        by_category.tool_result += chars;
        totalChars += chars;
        continue;
      }

      const texts = textParts(content);
      if (!texts) continue;
      const fullText = texts.join('\n');

      const tsRe = /<timestamp>([\s\S]*?)<\/timestamp>/g;
      let m;
      while ((m = tsRe.exec(fullText)) !== null) {
        by_category.system_reminder += m[0].length;
        totalChars += m[0].length;
      }

      const sysRe = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
      while ((m = sysRe.exec(fullText)) !== null) {
        by_category.system_reminder += m[0].length;
        totalChars += m[0].length;
      }

      const cmdRe = /<(?:command-name|command-message|command-args|local-command-stdout)>([\s\S]*?)<\/(?:command-name|command-message|command-args|local-command-stdout)>/g;
      while ((m = cmdRe.exec(fullText)) !== null) {
        by_category.command_blocks += m[0].length;
        totalChars += m[0].length;
      }

      const orchIdx = fullText.indexOf('[Orchestrator router]');
      if (orchIdx !== -1) {
        const suffixLen = fullText.length - orchIdx;
        by_category.orchestrator_suffix += suffixLen;
        totalChars += suffixLen;
      }

      const stripped = stripInjected(stripCursorEnvelope(fullText));
      if (stripped && AUTOMATION_MARKERS.some((mk) => stripped.includes(mk))) {
        by_category.automation_messages += stripped.length;
        totalChars += stripped.length;
      }
    }
  }
  const by_category_tokens = {};
  for (const [k, v] of Object.entries(by_category)) by_category_tokens[k] = Math.round(v / CHARS_PER_TOKEN);
  return { tokens: Math.round(totalChars / CHARS_PER_TOKEN), chars: totalChars, by_category: by_category_tokens, files, since };
}

// Main-session JSONLs only — skips subagents/ subdirs.
function listSessionTranscripts(projectDirPath) {
  if (!projectDirPath) return [];
  const dir = transcriptsDir(projectDirPath);
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  const out = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const main = path.join(dir, e.name, `${e.name}.jsonl`);
    try {
      if (fs.statSync(main).isFile()) out.push({ id: e.name, path: main });
    } catch { /* skip incomplete conversation dir */ }
  }
  return out;
}

function sessionTranscriptPath(mainTranscript, sessionId) {
  if (!mainTranscript || !sessionId) return null;
  const dir = path.dirname(mainTranscript);
  const base = path.basename(mainTranscript, '.jsonl');
  if (sessionId === base) return mainTranscript;
  const sub = path.join(dir, 'subagents', `${sessionId}.jsonl`);
  try { if (fs.existsSync(sub)) return sub; } catch { /* fall through */ }
  return path.join(dir, `${sessionId}.jsonl`);
}

module.exports = {
  encodeWorkspace,
  projectDir,
  transcriptsDir,
  stripCursorEnvelope,
  humanInputTokens,
  harnessOverheadTokens,
  countFile,
  listSessionTranscripts,
  sessionTranscriptPath,
  CURSOR_PROJECTS,
};
