'use strict';
// In-plugin wake re-injection for OpenCode.
// Watches a session's .fire file and, on each new ORCH_SCHEDULED_TASK line,
// re-injects the payload's prompt via the OpenCode SDK client (session.promptAsync).
// Reuses the shared fire-path resolution from lib/schedule-wakeup.js (do NOT hardcode paths).
const fs = require('fs');
const scheduleWakeup = require('./schedule-wakeup.js');

const PREFIX_RE = /^ORCH_SCHEDULED_TASK\s+(.+)$/;

// createWakeDelivery({ client, intervalMs }) -> { arm, cancel }
//   client: OpenCode SDK client (has client.session.promptAsync)
//   intervalMs: polling interval (default 1000ms)
function createWakeDelivery({ client, intervalMs = 1000 } = {}) {
  // One active watcher per session slug: { timer, offset }
  const watchers = new Map();
  // Processed byte offset per session slug — persists across cancel/arm so a
  // re-arm never re-fires an already-delivered line (dedup), while a first arm
  // processes any pre-existing fire-line once.
  const processed = new Map();

  function deliver(session, line) {
    const m = String(line).match(PREFIX_RE);
    if (!m) return;
    let payload;
    try {
      payload = JSON.parse(m[1]);
    } catch (_) {
      return; // malformed payload — best-effort, never throw
    }
    const prompt = payload && typeof payload === 'object'
      ? String(payload.prompt != null ? payload.prompt : '')
      : '';
    if (!prompt) return;
    try {
      const res = client.session.promptAsync({
        path: { id: session },
        body: { parts: [{ type: 'text', text: prompt }] },
      });
      // Drain eventual promise so rejections never surface as unhandled.
      if (res && typeof res.then === 'function') res.then(() => {}, () => {});
    } catch (_) {
      // delivery is best-effort; never throw out of the watcher
    }
  }

  function cancel(session) {
    const key = scheduleWakeup.sessionSlug(session);
    const w = watchers.get(key);
    if (!w) return;
    if (w.timer) clearInterval(w.timer);
    watchers.delete(key);
  }

  function arm(session) {
    if (!session) return { ok: false, error: 'session required' };
    if (!client || !client.session || typeof client.session.promptAsync !== 'function') {
      return { ok: false, error: 'client.session.promptAsync unavailable' };
    }

    // cancel-then-arm: tear down any prior watcher for this session (timer only;
    // processed offset is preserved for dedup).
    cancel(session);

    const key = scheduleWakeup.sessionSlug(session);
    const firePath = scheduleWakeup.fireFile(session);

    // Resume from the last processed offset for this session, or 0 on first arm.
    const entry = { timer: null, offset: processed.get(key) || 0 };
    watchers.set(key, entry);

    const tick = () => {
      let size = 0;
      try {
        size = fs.statSync(firePath).size;
      } catch (_) { return; }
      if (size <= entry.offset) return;

      let fd;
      try {
        fd = fs.openSync(firePath, 'r');
        const length = size - entry.offset;
        const buf = Buffer.allocUnsafe(length);
        fs.readSync(fd, buf, 0, length, entry.offset);
        const chunk = buf.toString('utf8');
        let consumed = chunk.length;
        const lines = chunk.split('\n');
        // If the chunk has no trailing newline, the final segment is a partial
        // line — hold it back (rewind) so it isn't processed until complete.
        if (!chunk.endsWith('\n')) {
          const partial = lines.pop();
          consumed -= partial ? partial.length : 0;
        }
        for (const line of lines) {
          const trimmed = line.replace(/\r$/, '');
          if (trimmed) deliver(session, trimmed);
        }
        entry.offset += consumed;
        processed.set(key, entry.offset);
      } catch (_) {
        // best-effort read; leave offset unchanged to retry next tick
      } finally {
        if (fd !== undefined) { try { fs.closeSync(fd); } catch (_) {} }
      }
    };

    entry.timer = setInterval(tick, intervalMs);
    if (entry.timer.unref) entry.timer.unref();
    return { ok: true, session, firePath };
  }

  return { arm, cancel };
}

module.exports = { createWakeDelivery };
