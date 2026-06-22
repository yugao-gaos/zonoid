'use strict';

const fs = require('fs');
const path = require('path');
const recallJournal = require('../recall-outcome-journal');

function isTaskContextTier(tier) {
  return tier === 'dag' || tier === 'dag-note' || tier === 'surrounding';
}

function recallPayload(event) {
  const taskKey = event && event.taskKey;
  if (!taskKey) return null;
  const results = Array.isArray(event.results) ? event.results : [];
  const noteKeys = results
    .filter((result) => (result.kind || 'task') === 'note' || (result.kind || 'task') === 'knowledge')
    .map((result) => result.key);
  const via = results.some((result) => isTaskContextTier(result.tier)) ? 'dag' : 'rag';
  const payload = { task_key: taskKey, recalled_note_keys: noteKeys, outcome: 'pending', via };
  if (Array.isArray(event.recalledContextEdges)) payload.recalled_context_edges = event.recalledContextEdges;
  return payload;
}

function appendGateJournal(workspace, row) {
  fs.appendFileSync(path.join(workspace, '.graph', 'gate-journal.jsonl'), JSON.stringify(row) + '\n');
}

function gateJournalRow(event, verdict) {
  const gate = (event && event.gate) || {};
  return {
    ts: new Date().toISOString(),
    workspace: event.workspace,
    query: event.query || '',
    task_key: event.taskKey || null,
    decision: verdict.decision,
    reason: verdict.reason,
    top1: verdict.top1,
    margin: verdict.margin,
    gap: verdict.gap,
    locality: verdict.locality,
    tagOverlap: verdict.tagOverlap,
    sharedTags: verdict.sharedTags,
    topType: verdict.topType,
    topKey: verdict.topKey || null,
    via: verdict.via || gate.gateVia,
    embedModel: event.embedModel,
    gated: !!gate.gated,
    round: event.round,
    ...((gate.kbMeta && typeof gate.kbMeta === 'object') ? gate.kbMeta : {}),
    ...((gate.taskMeta && typeof gate.taskMeta === 'object') ? gate.taskMeta : {}),
  };
}

async function writeSearchTelemetry(ctx, event) {
  if (!event || !event.workspace) return;

  if (event.skipRecall !== true) {
    const recall = recallPayload(event);
    if (recall) {
      try {
        recallJournal.appendRow(event.workspace, recall);
      } catch {
        // Recall attribution must not break the search response or telemetry drain.
      }
    }
  }

  const gate = event.gate || null;
  if (!gate) return;
  try {
    let verdict = gate.verdict || null;
    if (!verdict && gate.runGate && typeof ctx.gateTask === 'function') {
      verdict = await ctx.gateTask(gate.input, gate.candidates || [], {
        preScored: true,
        via: gate.gateVia,
      });
    }
    if (verdict) appendGateJournal(event.workspace, gateJournalRow(event, verdict));
  } catch {
    // Gate telemetry is best-effort learning data; never surface failures to /search.
  }
}

function writeRecallNow(event) {
  const recall = recallPayload(event);
  if (recall) {
    try {
      recallJournal.appendRow(event.workspace, recall);
    } catch {
      // Recall attribution must not break the search response or telemetry drain.
    }
  }
}

const queue = [];
let draining = false;

function scheduleDrain(ctx) {
  if (draining) return;
  draining = true;
  const later = typeof setImmediate === 'function' ? setImmediate : (fn) => setTimeout(fn, 0);
  later(async () => {
    try {
      while (queue.length) {
        const item = queue.shift();
        await writeSearchTelemetry(item.ctx || ctx, item.event);
      }
    } finally {
      draining = false;
      if (queue.length) scheduleDrain(ctx);
    }
  });
}

function defaultEnqueueSearchTelemetry(ctx, event) {
  writeRecallNow(event);
  queue.push({ ctx, event: { ...event, skipRecall: true } });
  scheduleDrain(ctx);
}

function enqueueSearchTelemetry(ctx, event) {
  const enqueue = ctx && ctx.enqueueSearchTelemetry;
  if (typeof enqueue === 'function') {
    try {
      enqueue(event);
    } catch {
      // Search must remain fail-open if a custom telemetry sink is unavailable.
    }
    return;
  }
  defaultEnqueueSearchTelemetry(ctx || {}, event);
}

async function drainForTest() {
  while (queue.length || draining) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
}

module.exports = {
  enqueueSearchTelemetry,
  writeSearchTelemetry,
  defaultEnqueueSearchTelemetry,
  __drainForTest: drainForTest,
  __recallPayloadForTest: recallPayload,
};
