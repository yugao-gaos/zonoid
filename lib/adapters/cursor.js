// Cursor harness adapter: file-drop tasks + Cursor transcript JSONLs under
// ~/.cursor/projects/<encoded-workspace>/agent-transcripts/. Token usage in Cursor
// transcripts is often absent — cost attribution falls back to agent reported_usage.
'use strict';
const filedrop = require('../filedrop-tasks');
const cursorTx = require('../cursor-transcripts');
const usage = require('../harness-usage');

const tasks = {
  aggregateWorkspace(ws, snapshots) { return filedrop.aggregate(ws, snapshots); },
  readTask(namespacedKey) { return filedrop.readTask(namespacedKey); },
  readSessionTasksRaw() { return []; },
  writeStatus(namespacedKey, status) { return filedrop.writeStatus(namespacedKey, status); },
  watch(onChange) { return filedrop.watch(onChange); },
  formatHealth() {
    return { sessions: 0, files: 0, parsed: 0, wellFormed: 0, anomalies: [], healthy: true };
  },
};

const transcripts = {
  source: 'transcripts',
  projectDir(ws) { return cursorTx.projectDir(ws); },
  sessionTranscriptPath(mainTranscript, sessionId) {
    return cursorTx.sessionTranscriptPath(mainTranscript, sessionId);
  },
  humanInputTokens(projectDir, opts) {
    if (!projectDir) return usage.emptyHuman(opts);
    try {
      const r = cursorTx.humanInputTokens(projectDir, opts);
      return r.files > 0 ? r : usage.emptyHuman(opts);
    } catch { return usage.emptyHuman(opts); }
  },
  harnessOverheadTokens(projectDir, opts) {
    if (!projectDir) return usage.emptyOverhead(opts);
    try {
      const r = cursorTx.harnessOverheadTokens(projectDir, opts);
      return r.files > 0 ? r : usage.emptyOverhead(opts);
    } catch { return usage.emptyOverhead(opts); }
  },
  listSessionTranscripts(projectDir) { return cursorTx.listSessionTranscripts(projectDir); },
  selfReportedUsage(agents, opts) { return usage.aggregateSelfReported(agents, opts); },
  taskUsageFromAgent(agent) { return usage.parseReportedUsage(agent); },
};

const scheduler = { writeScheduledTask() { return { ok: false, error: 'scheduler unavailable' }; } };

module.exports = { name: 'cursor', tasks, transcripts, scheduler };
