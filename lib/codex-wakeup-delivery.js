'use strict';
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const { isCodexProcessFallback } = require('./codex-session-bridge');
const codexSessionBridge = require('./codex-session-bridge');
const sw = require('./schedule-wakeup');

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

class CodexWakeDeliverySupervisor {
  constructor(opts = {}) {
    this.command = opts.command || process.env.CODEX_BIN || 'codex';
    this.spawnResume = opts.spawnResume;
    this.fireFile = opts.fireFile || sw.fireFile;
    this.ensureFireFile = opts.ensureFireFile || sw.ensureFireFile;
    this.restartDelayMs = Math.max(0, Number(opts.restartDelayMs ?? 100) || 0);
    this.logger = opts.logger || null;
    this.monitors = new Map();
  }

  supervise(sessionId) {
    const session = String(sessionId || '').trim();
    if (!session) return { ok: false, supervised: false, error: 'Codex session id required' };
    if (isCodexProcessFallback(session)) {
      return { ok: false, supervised: false, error: 'process-local Codex MCP fallback cannot resume Codex Desktop' };
    }
    const current = this.monitors.get(session);
    if (current && !current.closed) {
      return { ok: true, supervised: true, reused: true, session_id: session, fireFile: current.firePath || this.fireFile(session) };
    }

    const monitor = {
      sessionId: session,
      firePath: this.fireFile(session),
      watcher: null,
      restartTimer: null,
      offset: 0,
      buffer: '',
      draining: false,
      drainAgain: false,
      closed: false,
    };
    this.monitors.set(session, monitor);
    this._start(monitor);
    return { ok: true, supervised: true, reused: false, session_id: session, fireFile: monitor.firePath };
  }

  superviseBridgeWorkspaces(workspaces) {
    const wanted = new Set([...workspaces || []].map((ws) => {
      try { return path.resolve(String(ws)); } catch { return ''; }
    }).filter(Boolean));
    if (!wanted.size) return { ok: true, supervised: [], skipped: [] };
    const data = codexSessionBridge.readBridge();
    const records = (data && data.workspaces) || {};
    const supervised = [];
    const skipped = [];
    for (const [workspace, record] of Object.entries(records)) {
      let resolved = '';
      try { resolved = path.resolve(workspace); } catch { /* skip */ }
      if (!wanted.has(resolved)) continue;
      const result = this.supervise(record && record.session_id);
      if (result.ok) supervised.push(result);
      else skipped.push({ workspace: resolved, error: result.error });
    }
    return { ok: true, supervised, skipped };
  }

  stop(sessionId) {
    const session = String(sessionId || '').trim();
    const monitor = this.monitors.get(session);
    if (!monitor) return { ok: true, stopped: false };
    this._close(monitor);
    this.monitors.delete(session);
    return { ok: true, stopped: true };
  }

  stopAll() {
    for (const session of [...this.monitors.keys()]) this.stop(session);
    return { ok: true };
  }

  activeSessions() {
    return [...this.monitors.entries()].filter(([, m]) => !m.closed).map(([session]) => session);
  }

  _start(monitor) {
    if (monitor.closed) return;
    try {
      monitor.firePath = this.ensureFireFile(monitor.sessionId);
      const stat = fs.statSync(monitor.firePath);
      monitor.offset = stat.size;
      monitor.buffer = '';
      monitor.watcher = fs.watch(monitor.firePath, { persistent: false }, (eventType) => {
        if (eventType === 'rename') {
          this._restart(monitor);
          return;
        }
        this._drain(monitor);
      });
      if (typeof monitor.watcher.unref === 'function') monitor.watcher.unref();
      monitor.watcher.on('error', () => this._restart(monitor));
      setImmediate(() => this._drain(monitor));
    } catch (e) {
      this._scheduleRestart(monitor, e);
    }
  }

  _drain(monitor) {
    if (monitor.closed) return;
    if (monitor.draining) {
      monitor.drainAgain = true;
      return;
    }
    monitor.draining = true;
    try {
      const stat = fs.statSync(monitor.firePath);
      if (stat.size < monitor.offset) {
        monitor.offset = 0;
        monitor.buffer = '';
      }
      if (stat.size > monitor.offset) {
        const len = stat.size - monitor.offset;
        const buf = Buffer.alloc(len);
        const fd = fs.openSync(monitor.firePath, 'r');
        try {
          fs.readSync(fd, buf, 0, len, monitor.offset);
        } finally {
          fs.closeSync(fd);
        }
        monitor.offset = stat.size;
        this._handleChunk(monitor, buf.toString('utf8'));
      }
    } catch (e) {
      if (e && e.code === 'ENOENT') this._restart(monitor);
      else this._log(`codex wake supervisor read failed: ${e.message}`);
    } finally {
      monitor.draining = false;
      if (monitor.drainAgain) {
        monitor.drainAgain = false;
        setImmediate(() => this._drain(monitor));
      }
    }
  }

  _handleChunk(monitor, chunk) {
    const text = monitor.buffer + chunk;
    const parts = text.split(/\r?\n/);
    monitor.buffer = parts.pop() || '';
    for (const line of parts) {
      const result = handleWakeLine(line, {
        sessionId: monitor.sessionId,
        command: this.command,
        spawnResume: this.spawnResume,
      });
      if (result && result.error) this._log(result.error);
    }
  }

  _restart(monitor) {
    if (monitor.closed) return;
    if (monitor.watcher) {
      try { monitor.watcher.close(); } catch { /* already closed */ }
      monitor.watcher = null;
    }
    this._scheduleRestart(monitor);
  }

  _scheduleRestart(monitor, err) {
    if (monitor.closed || monitor.restartTimer) return;
    if (err) this._log(`codex wake supervisor restart scheduled: ${err.message}`);
    monitor.restartTimer = setTimeout(() => {
      monitor.restartTimer = null;
      this._start(monitor);
    }, this.restartDelayMs);
    if (typeof monitor.restartTimer.unref === 'function') monitor.restartTimer.unref();
  }

  _close(monitor) {
    monitor.closed = true;
    if (monitor.restartTimer) {
      clearTimeout(monitor.restartTimer);
      monitor.restartTimer = null;
    }
    if (monitor.watcher) {
      try { monitor.watcher.close(); } catch { /* already closed */ }
      monitor.watcher = null;
    }
  }

  _log(message) {
    if (!message) return;
    if (this.logger && typeof this.logger.warn === 'function') {
      this.logger.warn(message);
    } else if (typeof this.logger === 'function') {
      this.logger(message);
    }
  }
}

const defaultSupervisor = new CodexWakeDeliverySupervisor();

function superviseCodexSession(sessionId) {
  return defaultSupervisor.supervise(sessionId);
}

function superviseCodexBridgeWorkspaces(workspaces) {
  return defaultSupervisor.superviseBridgeWorkspaces(workspaces);
}

module.exports = {
  PREFIX,
  parseScheduledTaskLine,
  deliverPayload,
  handleWakeLine,
  createWakeDeliveryMonitor,
  CodexWakeDeliverySupervisor,
  superviseCodexSession,
  superviseCodexBridgeWorkspaces,
  defaultSupervisor,
};
