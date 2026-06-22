#!/usr/bin/env node
'use strict';
// PostToolUse(TaskCreate): after a task is created, ask the daemon which existing tasks (incl.
// completed) the new task should link to, and inject candidates so the agent wires it instead of
// leaving an orphan root node. Best-effort. Node port of suggest-links.sh.
const k = require('./lib/hookkit');

(async () => {
  const input = await k.readInput();
  const sid = input.session_id || '';
  if (!sid) k.allow();
  if (k.isOff(sid)) k.allow();          // opted out

  // new native task id from the TaskCreate response text ("Task #12 created successfully: ...")
  const m = JSON.stringify(input).match(/Task #(\d+)/);
  if (!m) k.allow();
  const key = `${sid}/${m[1]}`;

  // brief retry for the daemon's task-dir re-read after the new file lands
  let sug = null;
  for (let i = 0; i < 3; i++) {
    sug = await k.getJson(`/task/suggest?key=${encodeURIComponent(key)}`, 600);
    if (sug && Array.isArray(sug.suggestions) && sug.suggestions.length > 0) break;
    await new Promise((r) => setTimeout(r, 200));
  }

  // Quarantine reminder ALWAYS fires (even with zero candidates) — an unwired task can't be assigned.
  const quar = `Task ${key} created — it is QUARANTINED as unwired. Wire it now: suggest_links + add_dependency (blocking for prerequisites, context for related done work), or mark_root if genuinely standalone. Unwired tasks cannot be accepted with subconscious_assignment action:"accept".`;
  let ctx;
  if (sug && Array.isArray(sug.suggestions) && sug.suggestions.length > 0) {
    const lines = sug.suggestions.slice(0, 5)
      .map((s) => `  - ${s.key} [${s.status}] ${s.label} (score ${s.score}, suggest ${s.suggest_kind})`)
      .join('\n');
    ctx = `[Orchestrator] ${quar}\nCandidate links among existing tasks (incl. completed):\n${lines}\nFor relevant DONE matches call add_dependency(from=<match>, to=${key}, kind="context") so their summary becomes Tier-1 context; for a true prerequisite use kind="blocking". Skip unrelated ones.`;
  } else {
    ctx = `[Orchestrator] ${quar}`;
  }
  k.emitContext('PostToolUse', ctx);
})().catch(() => process.exit(0));
