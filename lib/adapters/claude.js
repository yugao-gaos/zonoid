// Claude Code harness adapter: implements the lib/harness.js interface by THIN delegation to
// the existing Claude-specific modules (lib/native-tasks, lib/human-input, lib/followups).
// No logic of its own beyond key splitting and path construction — behavior is identical to
// the pre-seam direct calls. The undocumented on-disk layouts stay isolated in the delegates.
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const nt = require('../native-tasks');
const humanInput = require('../human-input');
const followups = require('../followups');
const usage = require('../harness-usage');
const usageAccounting = require('../usage-accounting');
const scheduleWakeup = require('../schedule-wakeup');

// Split a namespaced 'session/id' key. Returns null for unkeyed input (no '/' or empty session).
function splitKey(namespacedKey) {
  const key = String(namespacedKey || '');
  const i = key.indexOf('/');
  if (i <= 0) return null;
  return { session: key.slice(0, i), id: key.slice(i + 1) };
}

const tasks = {
  aggregateWorkspace(ws, snapshots) { return nt.aggregateWorkspace(ws, snapshots); },

  readTask(namespacedKey) {
    const k = splitKey(namespacedKey);
    return k ? nt.readTask(k.session, k.id) : null;
  },

  // Every parseable task file of one session (~/.claude/tasks/<sessionId>/*.json), unfiltered.
  readSessionTasksRaw(sessionId) {
    const dir = path.join(os.homedir(), '.claude', 'tasks', sessionId);
    const out = [];
    try {
      for (const f of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
        try {
          const t = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
          if (t) out.push(t);
        } catch { /* skip unreadable/partial */ }
      }
    } catch { /* no tasks for session */ }
    return out;
  },

  writeStatus(namespacedKey, status) {
    const k = splitKey(namespacedKey);
    return k ? nt.writeStatus(k.session, k.id, status) : false;
  },

  // Watch the native task store; onChange fires on any write. Returns a disposer.
  // fs.watch can throw when the dir doesn't exist — callers fall back to their TTL caches.
  watch(onChange) {
    try {
      const w = fs.watch(path.join(os.homedir(), '.claude', 'tasks'), { recursive: true }, onChange);
      return () => { try { w.close(); } catch { /* already closed */ } };
    } catch { return () => {}; }
  },

  formatHealth(ws) { return nt.formatHealth(ws); },
};

const transcripts = {
  source: 'transcripts',
  // Claude Code keeps a workspace's transcript/usage JSONLs under
  // ~/.claude/projects/<encoded-workspace>/.
  projectDir(ws) { return path.join(os.homedir(), '.claude', 'projects', nt.encodeWorkspace(ws)); },

  // A session's transcript JSONL lives next to the main transcript as <sessionId>.jsonl.
  sessionTranscriptPath(mainTranscript, sessionId) {
    return path.join(path.dirname(mainTranscript), `${sessionId}.jsonl`);
  },

  humanInputTokens(projectDir, opts) { return humanInput.humanInputTokens(projectDir, opts); },
  harnessOverheadTokens(projectDir, opts) { return humanInput.harnessOverheadTokens(projectDir, opts); },
  listSessionTranscripts(projectDir) { return usage.listSessionTranscripts(projectDir); },
  selfReportedUsage(agents, opts) { return usage.aggregateSelfReported(agents, opts); },
  taskUsageFromAgent(agent) { return usage.parseReportedUsage(agent); },
};

const scheduler = {
  writeScheduledTask(opts) { return followups.writeScheduledTask(opts); },
  // Claude Code exposes ScheduleWakeup natively — no MCP duplicate or pidfile substrate here.
  armWakeup() { return { ok: true, method: 'native' }; },
  cancelWakeup() { return { ok: true, method: 'native', noop: true }; },
};

const usageApi = {
  sample(transcript_path, opts = {}) {
    const slice = usageAccounting.emptySlice('claude', {
      agent_id: opts.agent_id,
      session_id: opts.session_id,
      transcript_path,
      task_key: opts.task_key || null,
      startedAt: (opts.window && opts.window.start) || opts.startedAt || null,
      endedAt: (opts.window && opts.window.end) || opts.endedAt || null,
    });
    slice.usage = usageAccounting.parseTranscriptUsage(transcript_path, opts);
    slice.human = usageAccounting.humanForFile(transcript_path, opts);
    slice.overhead = { tokens: 0, by_category: {} };
    return slice;
  },
  normalizeReported(raw, ctx = {}) {
    return usageAccounting.normalizeReported(raw, 'claude', ctx);
  },
  reconcile(workspace, opts = {}) {
    const pd = transcripts.projectDir(workspace);
    const totals = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, by_model: {} };
    const sessions = [];
    for (const { id, path: tp } of usage.listSessionTranscripts(pd)) {
      const u = usageAccounting.parseTranscriptUsage(tp, opts.since ? { window: { start: opts.since } } : {});
      usageAccounting.mergeTotals(totals, u);
      sessions.push({ id, path: tp, total: u.output_tokens || 0 });
    }
    const human = transcripts.humanInputTokens(pd, { since: opts.since || null });
    return { harness: 'claude', workspace, totals, human, sessions };
  },
  onSessionStart({ session, port }) {
    if (!session) return { ok: false, skipped: true };
    scheduleWakeup.cancelWakeup(session);
    return scheduleWakeup.armWakeup({
      session,
      delaySeconds: 86400,
      reason: 'usage reconcile daily',
      prompt: usageAccounting.reconcilePrompt('claude', session, port),
    });
  },
};

module.exports = { name: 'claude', tasks, transcripts, scheduler, usage: usageApi };
