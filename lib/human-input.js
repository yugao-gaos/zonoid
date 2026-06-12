// Human-input denominator for the autonomy score: how many tokens did the user GENUINELY
// type? Parses main-session transcript JSONLs under ~/.claude/projects/<encoded-workspace>/
// (top-level *.jsonl only — the subagents/ subdir never holds human typing) and counts
// user-typed text, excluding everything machine-injected:
//   - non-user lines, isSidechain / isMeta lines, tool_result payloads;
//   - injected blocks stripped from the text (<system-reminder>, <command-*>,
//     <local-command-stdout>, trailing "[Orchestrator router]" verdicts);
//   - whole-message automation prompts (task notifications, scheduled tasks, judge
//     "=== CANDIDATES ===" prompts, onboarding-harness prompts, image/caveat stubs).
// Token estimate: chars / 3.8 (validated against the 2026-06-10 manual measurement).
'use strict';
const fs = require('fs');
const path = require('path');

const CHARS_PER_TOKEN = 3.8;
const AUTOMATION_MARKERS = [
  '<task-notification>', '<scheduled-task>', '=== CANDIDATES ===',
  'You are ONBOARDING', '[Image #', 'Caveat: The messages below',
];
const STRIP = [
  /<system-reminder>[\s\S]*?<\/system-reminder>/g,
  /<command-name>[\s\S]*?<\/command-name>/g,
  /<command-message>[\s\S]*?<\/command-message>/g,
  /<command-args>[\s\S]*?<\/command-args>/g,
  /<local-command-stdout>[\s\S]*?<\/local-command-stdout>/g,
];

function stripInjected(text) {
  for (const re of STRIP) text = text.replace(re, '');
  text = text.replace(/\[Orchestrator router\][\s\S]*$/, '');
  return text.trim();
}

// Count human-typed chars in ONE transcript JSONL. since: ISO timestamp lower bound
// (compared on the first 19 chars, prototype-compatible) or null for all time.
function countFile(file, since) {
  const r = { chars: 0, messages: 0, dropped: 0 };
  let raw;
  try { raw = fs.readFileSync(file, 'utf8'); } catch { return r; }
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    let d; try { d = JSON.parse(line); } catch { continue; }
    if (d.type !== 'user' || d.isSidechain || d.isMeta) continue;
    if (since && ((d.timestamp || '').slice(0, 19) < since.slice(0, 19))) continue;
    const content = (d.message || {}).content;
    let texts;
    if (typeof content === 'string') texts = [content];
    else if (Array.isArray(content)) {
      if (content.some((c) => c && c.type === 'tool_result')) continue; // tool output, not typing
      texts = content.filter((c) => c && c.type === 'text').map((c) => c.text || '');
    } else continue;
    const t = stripInjected(texts.join('\n'));
    if (!t) continue;
    if (AUTOMATION_MARKERS.some((m) => t.includes(m))) { r.dropped++; continue; }
    r.chars += t.length;
    r.messages++;
  }
  return r;
}

// Aggregate over every main-session transcript in a project dir.
// Returns { tokens, chars, messages, dropped, files, since }.
function humanInputTokens(projectDir, opts = {}) {
  const since = opts.since || null;
  const out = { tokens: 0, chars: 0, messages: 0, dropped: 0, files: 0, since };
  let entries = [];
  try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue; // skips subagents/ and other subdirs
    const r = countFile(path.join(projectDir, e.name), since);
    out.chars += r.chars; out.messages += r.messages; out.dropped += r.dropped; out.files++;
  }
  out.tokens = Math.round(out.chars / CHARS_PER_TOKEN);
  return out;
}

// Count harness-injected (machine-side) overhead tokens from the same transcript files.
// Returns totals broken out by category: system_reminder, tool_result, command_blocks,
// automation_messages, orchestrator_suffix.
function harnessOverheadTokens(projectDir, opts = {}) {
  const since = opts.since || null;
  const by_category = { system_reminder: 0, tool_result: 0, command_blocks: 0, automation_messages: 0, orchestrator_suffix: 0 };
  let totalChars = 0;
  let files = 0;
  let entries = [];
  try { entries = fs.readdirSync(projectDir, { withFileTypes: true }); } catch { /* no dir */ }
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
    files++;
    let raw;
    try { raw = fs.readFileSync(path.join(projectDir, e.name), 'utf8'); } catch { continue; }
    for (const line of raw.split('\n')) {
      if (!line.trim()) continue;
      let d; try { d = JSON.parse(line); } catch { continue; }
      if (d.type !== 'user') continue;
      if (since && ((d.timestamp || '').slice(0, 19) < since.slice(0, 19))) continue;
      const content = (d.message || {}).content;

      // isSidechain / isMeta whole-message overhead
      if (d.isSidechain || d.isMeta) {
        let texts;
        if (typeof content === 'string') texts = [content];
        else if (Array.isArray(content)) texts = content.filter((c) => c && c.type === 'text').map((c) => c.text || '');
        else texts = [];
        const chars = texts.join('\n').length;
        by_category.automation_messages += chars;
        totalChars += chars;
        continue;
      }

      if (Array.isArray(content)) {
        // tool_result messages
        if (content.some((c) => c && c.type === 'tool_result')) {
          const chars = content.reduce((s, c) => {
            if (!c) return s;
            if (typeof c.content === 'string') return s + c.content.length;
            if (Array.isArray(c.content)) return s + c.content.filter((x) => x && x.type === 'text').reduce((ss, x) => ss + (x.text || '').length, 0);
            return s;
          }, 0);
          by_category.tool_result += chars;
          totalChars += chars;
          continue;
        }
      }

      // For regular user messages: extract injected sub-content
      let texts;
      if (typeof content === 'string') texts = [content];
      else if (Array.isArray(content)) texts = content.filter((c) => c && c.type === 'text').map((c) => c.text || '');
      else continue;
      const fullText = texts.join('\n');

      // system-reminder blocks
      const sysRe = /<system-reminder>([\s\S]*?)<\/system-reminder>/g;
      let m;
      while ((m = sysRe.exec(fullText)) !== null) {
        by_category.system_reminder += m[0].length;
        totalChars += m[0].length;
      }

      // command blocks
      const cmdRe = /<(?:command-name|command-message|command-args|local-command-stdout)>([\s\S]*?)<\/(?:command-name|command-message|command-args|local-command-stdout)>/g;
      while ((m = cmdRe.exec(fullText)) !== null) {
        by_category.command_blocks += m[0].length;
        totalChars += m[0].length;
      }

      // orchestrator suffix
      const orchIdx = fullText.indexOf('[Orchestrator router]');
      if (orchIdx !== -1) {
        const suffixLen = fullText.length - orchIdx;
        by_category.orchestrator_suffix += suffixLen;
        totalChars += suffixLen;
      }

      // automation messages (whole message)
      const stripped = stripInjected(fullText);
      if (stripped && AUTOMATION_MARKERS.some((mk) => stripped.includes(mk))) {
        const chars = stripped.length;
        by_category.automation_messages += chars;
        totalChars += chars;
      }
    }
  }
  const by_category_tokens = {};
  for (const [k, v] of Object.entries(by_category)) by_category_tokens[k] = Math.round(v / CHARS_PER_TOKEN);
  return {
    tokens: Math.round(totalChars / CHARS_PER_TOKEN),
    chars: totalChars,
    by_category: by_category_tokens,
    files,
    since,
  };
}

module.exports = { humanInputTokens, harnessOverheadTokens, countFile, stripInjected, CHARS_PER_TOKEN, AUTOMATION_MARKERS };
