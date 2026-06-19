'use strict';
// Shared cross-platform helper for the orchestrator hooks.
//
// WHY: the original hooks were bash scripts that shelled out to jq/curl/python3/sed/awk — none of
// which are guaranteed on Windows. Node is the ONE runtime we can rely on (the daemon and the MCP
// server are both Node, package.json engines.node>=18), so every hook is now a `.js` invoked as
// `node <hook>.js`. This module is the common kit: stdin JSON, daemon HTTP, path/exit helpers, and
// the trivial-patch accounting that orch-gate-trivial.sh used to provide.
//
// Conventions preserved from the bash hooks:
//   - exit 0 = allow / no-op, exit 2 = deny (stderr carries the reason).
//   - daemon unreachable / timed out => fail OPEN (return null, caller allows).
//   - data dir = ORCH_DATA, ZONOID_DATA, or legacy CLAUDE_PLUGIN_DATA; sessions/<id>.off = opted out.

const http = require('http');
const fs = require('fs');
const path = require('path');
const runtimePaths = require('../../lib/runtime-paths');

const PORT = process.env.ORCH_PORT ? Number(process.env.ORCH_PORT) : 8787;
const IS_WIN = process.platform === 'win32';

// ── stdin ──────────────────────────────────────────────────────────────────
// Claude Code pipes the hook payload as JSON on stdin. Resolve {} on anything unexpected so a
// malformed payload degrades to "no-op" rather than throwing.
function readInput() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) { resolve({}); return; }
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => { buf += c; });
    process.stdin.on('end', () => { try { resolve(JSON.parse(buf)); } catch { resolve({}); } });
    process.stdin.on('error', () => resolve({}));
  });
}

// ── daemon HTTP (replaces curl) ──────────────────────────────────────────────
// Returns the response body string, or null on error/timeout (fail-open). timeoutMs mirrors the
// per-call `curl --max-time` values from the bash hooks.
function request(method, p, body, timeoutMs) {
  return new Promise((resolve) => {
    let data = null;
    if (body != null) data = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body));
    const req = http.request(
      {
        host: '127.0.0.1',
        port: PORT,
        path: p,
        method,
        headers: data ? { 'content-type': 'application/json', 'content-length': data.length } : {},
        timeout: timeoutMs || 600,
      },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (d) => { out += d; });
        res.on('end', () => resolve(out));
      }
    );
    req.on('error', () => resolve(null));
    req.on('timeout', () => { req.destroy(); resolve(null); });
    if (data) req.write(data);
    req.end();
  });
}
async function getText(p, timeoutMs) { return request('GET', p, null, timeoutMs); }
async function getJson(p, timeoutMs) {
  const t = await getText(p, timeoutMs);
  if (!t) return null;
  try { return JSON.parse(t); } catch { return null; }
}
async function post(p, body, timeoutMs) { return request('POST', p, body, timeoutMs); }
function ping(timeoutMs) {
  return getText('/ping', timeoutMs || 300).then((r) => r != null);
}

// ── paths / opt-out marker ───────────────────────────────────────────────────
function dataDir() {
  return runtimePaths.resolveDataDir();
}
function sessionsDir() { return path.join(dataDir(), 'sessions'); }
function offMarker(sid) { return path.join(sessionsDir(), `${sid}.off`); }
function isOff(sid) { try { return !!sid && fs.existsSync(offMarker(sid)); } catch { return false; } }
function setOff(sid) {
  if (!sid) return;
  try { fs.mkdirSync(sessionsDir(), { recursive: true }); fs.writeFileSync(offMarker(sid), ''); } catch { /* ignore */ }
}
function clearOff(sid) { try { fs.rmSync(offMarker(sid), { force: true }); } catch { /* ignore */ } }
function gateOff() { return process.env.ORCH_GATE_OFF === '1'; }

// ── path matching (cross-platform) ───────────────────────────────────────────
// Hook payloads carry native paths — backslashes on Windows. Normalize to forward slashes so the
// allow-list globs (written with '/') match on every OS. Windows FS is case-insensitive, so prefix
// comparisons lower-case there.
function slash(p) { return String(p || '').replace(/\\/g, '/'); }
function cmp(p) { const s = slash(p); return IS_WIN ? s.toLowerCase() : s; }
function isUnder(target, dir) {
  if (!target || !dir) return false;
  const t = cmp(target); const d = cmp(dir).replace(/\/+$/, '');
  return t === d || t.startsWith(d + '/');
}
// Collapse '/x/../' segments — port of the bash normalize_path helper.
function normalizePath(p) {
  let s = slash(p);
  let prev;
  do { prev = s; s = s.replace(/\/[^/]+\/\.\.(\/|$)/g, '/'); } while (s !== prev);
  return s.replace(/\/[^/]+\/\.\.$/, '');
}

// ── exit / output helpers ────────────────────────────────────────────────────
function allow() { process.exit(0); }
function deny(msg) { if (msg) process.stderr.write(String(msg) + '\n'); process.exit(2); }
// Emit a hookSpecificOutput context blob (replaces the printf+`jq -Rs` JSON-encoding dance).
function emitContext(eventName, additionalContext) {
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: eventName, additionalContext } }));
  process.exit(0);
}

// ── trivial-patch accounting (port of orch-gate-trivial.sh) ──────────────────
const TRIVIAL_MAX_LINES = 20;
const TRIVIAL_MAX_CHARS = 800;
function trivialCounterPath(sid) { return path.join(sessionsDir(), `${sid}.trivial-edit`); }
function resetTrivialCounter(sid) {
  if (!sid) return;
  try { fs.mkdirSync(sessionsDir(), { recursive: true }); fs.writeFileSync(trivialCounterPath(sid), '0\n'); } catch { /* ignore */ }
}
function patchWithinLimits(content) {
  const s = content || '';
  const chars = Buffer.byteLength(s, 'utf8');
  const lines = s.length === 0 ? 0 : s.split('\n').length;
  return chars <= TRIVIAL_MAX_CHARS && lines <= TRIVIAL_MAX_LINES;
}
async function dispatcherChildren(sid) { return getJson(`/dispatcher/children?session=${encodeURIComponent(sid)}`, 600); }
async function hasInflightWorkers(sid) {
  const r = await dispatcherChildren(sid);
  return !!(r && Array.isArray(r.children) && r.children.length > 0);
}
// Returns { attribution, denyReason }. denyReason='focus' when multiple workers need an explicit
// dispatcher focus before a trivial edit is attributable.
async function trivialAttribution(sid) {
  const r = await dispatcherChildren(sid);
  if (!r) return { attribution: '', denyReason: 'no_workers' };
  if (r.needs_focus === true && !(r.attribution && r.attribution.length)) return { attribution: '', denyReason: 'focus' };
  return { attribution: r.attribution || '', denyReason: '' };
}
async function reportDispatcherEdit(sid, chars, file, attribution) {
  if (!sid) return;
  await post('/usage/dispatcher-edit', {
    parent_session: sid,
    task_key: attribution || null,
    chars: chars || 0,
    file: file || null,
  }, 600);
}
// One trivial patch per turn for an unclaimed main/dispatcher session, and only while a worker is in
// flight + attributable. Returns { ok, denyReason, attribution }.
async function tryTrivialMainAllow(sid, content) {
  if (!sid) return { ok: false, denyReason: '' };
  if (!patchWithinLimits(content)) return { ok: false, denyReason: '' };
  if (!(await hasInflightWorkers(sid))) return { ok: false, denyReason: 'no_workers' };
  const { attribution, denyReason } = await trivialAttribution(sid);
  if (!attribution) return { ok: false, denyReason: denyReason || 'focus' };
  let count = 0;
  try { count = parseInt(String(fs.readFileSync(trivialCounterPath(sid), 'utf8')).trim(), 10) || 0; } catch { count = 0; }
  if (count >= 1) return { ok: false, denyReason: 'budget', attribution };
  try { fs.mkdirSync(sessionsDir(), { recursive: true }); fs.writeFileSync(trivialCounterPath(sid), '1\n'); }
  catch { return { ok: false, denyReason: '', attribution }; }
  return { ok: true, denyReason: '', attribution };
}
function mainSessionDenyMessage(denyReason) {
  switch (denyReason) {
    case 'budget':
      return 'orch-gate: trivial patch budget exhausted for this turn (1 allowed). Dispatch a subagent for further edits.';
    case 'no_workers':
      return 'orch-gate: no in-flight workers. Main/dispatcher sessions must NOT claim tasks directly. Register a task first (Claude TaskCreate, or adapter file-drop create_task/task_create), then spawn a background subagent (Agent tool, run_in_background:true) — the subagent calls branch_task then start_task before editing.';
    case 'focus':
      return 'orch-gate: multiple in-flight workers — set dispatcher focus (POST /overlay/dispatcher-focus) before trivial edits.';
    default:
      return 'orch-gate: no task claimed. Main/dispatcher sessions must NOT claim tasks directly. Register a task first (Claude TaskCreate, or adapter file-drop create_task/task_create), then spawn a background subagent (Agent tool, run_in_background:true) — the subagent calls branch_task then start_task before editing.';
  }
}

module.exports = {
  PORT, IS_WIN,
  readInput,
  request, getText, getJson, post, ping,
  dataDir, sessionsDir, offMarker, isOff, setOff, clearOff, gateOff,
  slash, cmp, isUnder, normalizePath,
  allow, deny, emitContext,
  TRIVIAL_MAX_LINES, TRIVIAL_MAX_CHARS,
  resetTrivialCounter, patchWithinLimits, dispatcherChildren, hasInflightWorkers,
  trivialAttribution, reportDispatcherEdit, tryTrivialMainAllow, mainSessionDenyMessage,
};
