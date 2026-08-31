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
const crypto = require('crypto');
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
const SESSION_META_MAX_BYTES = 8192;
const CODEX_THREAD_ID_RE = /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i;
const TURN_BINDING_MAX_BYTES = 4096;
const TURN_BINDING_TTL_MS = 60 * 60 * 1000;
const TURN_BINDING_FIELD_MAX_BYTES = 512;

function turnBindingsDir() { return path.join(dataDir(), 'turn-bindings'); }
function boundedTurnBindingField(value) {
  const text = typeof value === 'string' ? value.trim() : '';
  return text && !text.includes('\0') && Buffer.byteLength(text, 'utf8') <= TURN_BINDING_FIELD_MAX_BYTES
    ? text
    : '';
}
function turnBindingPath(parentSession, turnId) {
  const parent = boundedTurnBindingField(parentSession);
  const turn = boundedTurnBindingField(turnId);
  if (!parent || !turn) return '';
  const key = crypto.createHash('sha256').update(parent).update('\0').update(turn).digest('hex');
  return path.join(turnBindingsDir(), `${key}.json`);
}
function readTurnBindingRecord(file) {
  if (!file) return null;
  let fd;
  try {
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size <= 0 || stat.size > TURN_BINDING_MAX_BYTES) return null;
    const buffer = Buffer.alloc(stat.size);
    if (fs.readSync(fd, buffer, 0, buffer.length, 0) !== buffer.length) return null;
    return JSON.parse(buffer.toString('utf8'));
  } catch { return null; }
  finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
}
function turnBoundSessionId(input, now = Date.now()) {
  const parent = boundedTurnBindingField(input && input.session_id);
  const turn = boundedTurnBindingField(input && input.turn_id);
  const file = turnBindingPath(parent, turn);
  const record = readTurnBindingRecord(file);
  const child = boundedTurnBindingField(record && record.child_session_id);
  const expiresAt = Date.parse(record && record.expires_at);
  if (!record || record.version !== 1 || record.parent_session_id !== parent ||
      record.turn_id !== turn || !child || !Number.isFinite(expiresAt) || expiresAt <= now) return '';
  return child;
}
function bindTurnSession(input, permit, taskKey, agentId, now = Date.now()) {
  const ti = input && input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const parent = boundedTurnBindingField(input && input.session_id);
  const turn = boundedTurnBindingField(input && input.turn_id);
  const requestedChild = boundedTurnBindingField(ti.session_id);
  const permitChild = boundedTurnBindingField(permit && permit.session_id);
  const permitWorkspace = boundedTurnBindingField(permit && permit.workspace);
  const acceptedTask = boundedTurnBindingField(taskKey);
  const acceptedAgent = boundedTurnBindingField(agentId);
  if (!parent || !turn || !requestedChild || requestedChild === parent || requestedChild !== permitChild ||
      !permitWorkspace || !acceptedTask || !acceptedAgent || permit.task_key !== acceptedTask ||
      permit.agent_id !== acceptedAgent) return false;

  const suppliedExpiry = permit.expires_at == null ? NaN : Date.parse(permit.expires_at);
  if (permit.expires_at != null && (!Number.isFinite(suppliedExpiry) || suppliedExpiry <= now)) return false;
  const expiresAt = Math.min(
    Number.isFinite(suppliedExpiry) ? suppliedExpiry : now + TURN_BINDING_TTL_MS,
    now + TURN_BINDING_TTL_MS,
  );
  const file = turnBindingPath(parent, turn);
  if (!file) return false;
  const record = {
    version: 1,
    parent_session_id: parent,
    turn_id: turn,
    child_session_id: requestedChild,
    task_key: acceptedTask,
    agent_id: acceptedAgent,
    permit_id: boundedTurnBindingField(permit.id) || null,
    created_at: new Date(now).toISOString(),
    expires_at: new Date(expiresAt).toISOString(),
  };
  const encoded = `${JSON.stringify(record)}\n`;
  if (Buffer.byteLength(encoded, 'utf8') > TURN_BINDING_MAX_BYTES) return false;

  const dir = turnBindingsDir();
  const lock = `${file}.lock`;
  let temp = '';
  let fd;
  let lockOwned = false;
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.mkdirSync(lock, { mode: 0o700 });
    lockOwned = true;
    const current = readTurnBindingRecord(file);
    if (current) {
      const currentExpiry = Date.parse(current.expires_at);
      if (current.version === 1 && current.parent_session_id === parent && current.turn_id === turn &&
          current.child_session_id === requestedChild && current.task_key === acceptedTask &&
          current.agent_id === acceptedAgent && Number.isFinite(currentExpiry) && currentExpiry > now) return true;
      if (Number.isFinite(currentExpiry) && currentExpiry > now) return false;
    }
    try { fs.unlinkSync(file); } catch (error) { if (error && error.code !== 'ENOENT') return false; }
    temp = path.join(dir, `.${path.basename(file)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`);
    fd = fs.openSync(temp, fs.constants.O_CREAT | fs.constants.O_EXCL | fs.constants.O_WRONLY |
      (fs.constants.O_NOFOLLOW || 0), 0o600);
    fs.writeFileSync(fd, encoded, 'utf8');
    fs.fsyncSync(fd);
    fs.closeSync(fd);
    fd = undefined;
    fs.renameSync(temp, file);
    temp = '';
    return true;
  } catch { return false; }
  finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ }
    if (temp) try { fs.unlinkSync(temp); } catch { /* ignore */ }
    if (lockOwned) try { fs.rmdirSync(lock); } catch { /* fail closed on an interrupted writer */ }
  }
}

function transcriptSessionId(input, expectedParentSession = '') {
  const observedSession = input && typeof input.session_id === 'string' ? input.session_id.trim() : '';
  const expectedParent = typeof expectedParentSession === 'string' ? expectedParentSession.trim() : '';
  if (!observedSession) return '';
  const candidates = [input.agent_transcript_path, input.transcript_path];
  const seen = new Set();
  for (const candidate of candidates) {
    if (typeof candidate !== 'string' || !path.isAbsolute(candidate) || seen.has(candidate)) continue;
    seen.add(candidate);
    let fd;
    try {
      const flags = fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0);
      fd = fs.openSync(candidate, flags);
      if (!fs.fstatSync(fd).isFile()) continue;
      const buffer = Buffer.alloc(SESSION_META_MAX_BYTES + 1);
      const bytesRead = fs.readSync(fd, buffer, 0, buffer.length, 0);
      const newline = buffer.indexOf(0x0a, 0, bytesRead);
      if (newline < 0 || newline > SESSION_META_MAX_BYTES) continue;
      const record = JSON.parse(buffer.subarray(0, newline).toString('utf8'));
      const meta = record && record.type === 'session_meta' ? record.payload : null;
      const childSession = meta && typeof meta.id === 'string' ? meta.id.trim() : '';
      const parentSession = meta && typeof meta.session_id === 'string' ? meta.session_id.trim() : '';
      const parentThread = meta && typeof meta.parent_thread_id === 'string' ? meta.parent_thread_id.trim() : '';
      const windowId = meta && meta.context_window && typeof meta.context_window.window_id === 'string'
        ? meta.context_window.window_id.trim()
        : '';
      if (childSession && parentSession && parentSession === parentThread &&
          (!expectedParent || parentSession === expectedParent) &&
          (observedSession === parentSession || observedSession === windowId)) return childSession;
    } catch { /* untrusted or incomplete transcript metadata */ }
    finally { if (fd !== undefined) try { fs.closeSync(fd); } catch { /* ignore */ } }
  }
  return '';
}

function hookSessionId(input, env = process.env) {
  const boundChild = turnBoundSessionId(input);
  if (boundChild) return boundChild;
  const transportAgent = input && typeof input.agent_id === 'string' ? input.agent_id.trim() : '';
  const hasTranscriptCandidate = !!(input && [input.agent_transcript_path, input.transcript_path]
    .some((candidate) => typeof candidate === 'string' && candidate.trim()));
  const threadId = typeof env.CODEX_THREAD_ID === 'string' ? env.CODEX_THREAD_ID.trim() : '';
  if (threadId) {
    // Desktop collaboration hooks document the parent thread here. Only a validated turn binding
    // or bounded legacy transcript proof may select a child; agent_id is not a documented input.
    const transcriptChild = transcriptSessionId(input, threadId);
    if (transcriptChild && transcriptChild !== threadId && transportAgent === transcriptChild) {
      return transcriptChild;
    }
    return threadId;
  }
  const transcriptChild = transcriptSessionId(input);
  if (transcriptChild) return transcriptChild;
  // Retain the CLI/top-level transport behavior only when no parent CODEX_THREAD_ID exists.
  if (!hasTranscriptCandidate && CODEX_THREAD_ID_RE.test(transportAgent)) return transportAgent;
  return input && typeof input.session_id === 'string' ? input.session_id.trim() : '';
}
function hookAgentId(input) {
  const ti = input && input.tool_input && typeof input.tool_input === 'object' ? input.tool_input : {};
  const raw = input && (input.agent_id || ti.agent_id) ? String(input.agent_id || ti.agent_id).trim() : '';
  const transcriptSession = transcriptSessionId(input);
  return raw && (raw === transcriptSession || CODEX_THREAD_ID_RE.test(raw)) ? '' : raw;
}

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
function trivialCounterCount(sid) {
  try { return parseInt(String(fs.readFileSync(trivialCounterPath(sid), 'utf8')).trim(), 10) || 0; }
  catch { return 0; }
}
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
  const count = trivialCounterCount(sid);
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
      return 'orch-gate: no in-flight workers. Main/dispatcher sessions must NOT claim tasks directly. Ask Subconscious for an assignment with subconscious_assignment action:"prepare", then spawn a background worker to use subconscious_assignment action:"accept" before editing.';
    case 'focus':
      return 'orch-gate: multiple in-flight workers — set dispatcher focus (POST /overlay/dispatcher-focus) before trivial edits.';
    default:
      return 'orch-gate: no task claimed. Main/dispatcher sessions must NOT claim tasks directly. Ask Subconscious for an assignment with subconscious_assignment action:"prepare", then spawn a background worker to use subconscious_assignment action:"accept" before editing.';
  }
}

module.exports = {
  PORT, IS_WIN,
  readInput,
  request, getText, getJson, post, ping,
  dataDir, sessionsDir, offMarker, isOff, setOff, clearOff, gateOff,
  transcriptSessionId, turnBindingPath, turnBoundSessionId, bindTurnSession, hookSessionId, hookAgentId,
  slash, cmp, isUnder, normalizePath,
  allow, deny, emitContext,
  TRIVIAL_MAX_LINES, TRIVIAL_MAX_CHARS,
  trivialCounterCount, resetTrivialCounter, patchWithinLimits, dispatcherChildren, hasInflightWorkers,
  trivialAttribution, reportDispatcherEdit, tryTrivialMainAllow, mainSessionDenyMessage,
};
