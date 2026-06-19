'use strict';
const { spawn } = require('child_process');
const { isCodexProcessFallback } = require('./codex-session-bridge');

const PREFIX = 'ORCH_SCHEDULED_TASK';

function parseScheduledTaskLine(line) {
  const raw = String(line || '').trim();
  const m = raw.match(/^ORCH_SCHEDULED_TASK(?:\s+(.+))?$/);
  if (!m) return { ok: true, ignored: true };
  const json = String(m[1] || '').trim();
  if (!json) return { ok: false, ignored: true, error: 'missing scheduled task payload' };
  try {
    const payload = JSON.parse(json);
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { ok: false, ignored: true, error: 'scheduled task payload must be an object' };
    }
    return { ok: true, payload };
  } catch (e) {
    return { ok: false, ignored: true, error: `invalid scheduled task payload: ${e.message}` };
  }
}

function defaultSpawnResume(command, args, opts) {
  const child = spawn(command, args, opts);
  child.on('error', (e) => {
    process.stderr.write(`codex wake delivery failed: ${e.message}\n`);
  });
  return child;
}

function deliverPayload(payload, opts = {}) {
  const sessionId = String(opts.sessionId || '').trim();
  if (!sessionId) return { ok: false, error: 'Codex session id required' };
  if (isCodexProcessFallback(sessionId)) {
    return { ok: false, error: 'process-local Codex MCP fallback cannot resume Codex Desktop' };
  }
  const command = opts.command || 'codex';
  const prompt = String(payload && payload.prompt != null ? payload.prompt : '');
  const spawnResume = opts.spawnResume || defaultSpawnResume;
  const args = ['resume', sessionId, prompt];
  spawnResume(command, args, { stdio: 'inherit' });
  return { ok: true, command, args };
}

function handleWakeLine(line, opts = {}) {
  const parsed = parseScheduledTaskLine(line);
  if (!parsed.ok || parsed.ignored) return parsed;
  return deliverPayload(parsed.payload, opts);
}

function createWakeDeliveryMonitor(opts = {}) {
  return {
    handleLine(line) {
      return handleWakeLine(line, opts);
    },
  };
}

module.exports = {
  PREFIX,
  parseScheduledTaskLine,
  deliverPayload,
  handleWakeLine,
  createWakeDeliveryMonitor,
};
