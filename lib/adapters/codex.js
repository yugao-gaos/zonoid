// Codex harness adapter: file-drop tasks + self-reported usage; hookless scheduler substrate.
'use strict';
const filedrop = require('../filedrop-tasks');
const usage = require('../harness-usage');
const scheduler = require('./scheduler-substrate');

const tasks = {
  aggregateWorkspace(ws, snapshots) { return filedrop.aggregate(ws, snapshots); },
  readTask(namespacedKey) { return filedrop.readTask(namespacedKey); },
  readSessionTasksRaw() { return []; },
  writeStatus(namespacedKey, status) { return filedrop.writeStatus(namespacedKey, status); },
  watch(onChange) { return filedrop.watch(onChange); },
  formatHealth() { return { sessions: 0, files: 0, parsed: 0, wellFormed: 0, anomalies: [], healthy: true }; },
};

const transcripts = {
  source: 'self_reported',
  projectDir() { return null; },
  sessionTranscriptPath() { return null; },
  listSessionTranscripts() { return []; },
  humanInputTokens(_p, opts) { return usage.emptyHuman(opts); },
  harnessOverheadTokens(_p, opts) { return usage.emptyOverhead(opts); },
  selfReportedUsage(agents, opts) { return usage.aggregateSelfReported(agents, opts); },
  taskUsageFromAgent(agent) { return usage.parseReportedUsage(agent); },
};

module.exports = { name: 'codex', tasks, transcripts, scheduler };
