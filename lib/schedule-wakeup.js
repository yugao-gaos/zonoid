// Shared ScheduleWakeup substrate: cancel prior wake for a session, arm a delayed re-prompt.
// Pidfiles under resolveWakeDir()/<session-slug>.pid; wake lines append to <session-slug>.fire.
// On fire, a detached sleeper appends:
//   ORCH_SCHEDULED_TASK {"delaySeconds":N,"reason":"...","prompt":"..."}
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

function resolveDataDir() {
  return process.env.ORCH_DATA
    || process.env.CLAUDE_PLUGIN_DATA
    || path.join(os.homedir(), '.claude', 'orchestrator');
}

function resolveWakeDir() {
  return path.join(resolveDataDir(), 'wake');
}

function sessionSlug(session) {
  const s = String(session || '').replace(/[^A-Za-z0-9._-]/g, '_');
  return s || 'unknown';
}

function pidFile(session) {
  return path.join(resolveWakeDir(), `${sessionSlug(session)}.pid`);
}

function fireFile(session) {
  return path.join(resolveWakeDir(), `${sessionSlug(session)}.fire`);
}

function cancelWakeup(session) {
  if (!session) return { ok: false, error: 'session required' };
  const pf = pidFile(session);
  try {
    if (!fs.existsSync(pf)) return { ok: true, canceled: false };
    const pid = parseInt(fs.readFileSync(pf, 'utf8').trim(), 10);
    fs.unlinkSync(pf);
    if (Number.isInteger(pid) && pid > 0) {
      try { process.kill(pid, 'SIGTERM'); } catch (e) { if (e.code !== 'ESRCH') throw e; }
    }
    return { ok: true, canceled: true, pid: Number.isInteger(pid) ? pid : undefined };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function armWakeup({ session, delaySeconds, reason = '', prompt = '' }) {
  if (!session) return { ok: false, error: 'session required' };
  const delay = Math.max(0, Math.floor(Number(delaySeconds) || 0));
  const prior = cancelWakeup(session);
  if (!prior.ok) return prior;
  fs.mkdirSync(resolveWakeDir(), { recursive: true });
  const payload = { delaySeconds: delay, reason: String(reason), prompt: String(prompt) };
  const firePath = fireFile(session);
  const script = [
    'const fs = require("fs");',
    'const p = JSON.parse(process.argv[1]);',
    'const fire = process.argv[2];',
    'setTimeout(() => {',
    '  fs.appendFileSync(fire, "ORCH_SCHEDULED_TASK " + JSON.stringify(p) + "\\n");',
    `}, ${delay * 1000});`,
  ].join('\n');
  const child = spawn(process.execPath, ['-e', script, JSON.stringify(payload), firePath], {
    detached: true,
    stdio: 'ignore',
  });
  child.unref();
  const pf = pidFile(session);
  const tmp = `${pf}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, String(child.pid));
  fs.renameSync(tmp, pf);
  return { ok: true, pid: child.pid, delaySeconds: delay, session };
}

module.exports = {
  resolveDataDir,
  resolveWakeDir,
  sessionSlug,
  pidFile,
  fireFile,
  cancelWakeup,
  armWakeup,
};
