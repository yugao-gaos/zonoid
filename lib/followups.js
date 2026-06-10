// Structural follow-ups: when complete_task carries a `follow_ups` array, the daemon turns each
// item into an overlay-originated graph task instead of letting it evaporate as prose in the
// summary. The node rides the SNAPSHOT substrate (overlay.snapshots, key 'followup/<id>') — the
// same mechanism that keeps retention-swept native tasks in the graph — so buildGraph, status
// derivation, the heartbeat loop and suggest_links all work on it with zero special-casing.
// NEVER writes into ~/.claude/tasks/ (native task files are read-only to us — hard convention).
//
// Routing per item ({ title, prompt, when?, disruptive? }):
//   - no `when` / "asap" / past timestamp, not disruptive → node derives READY; the existing
//     heartbeat loop (next_action) picks it up. Nothing else to do.
//   - future ISO `when`, not disruptive → node gets a not_ready override (so the loop can't fire
//     it early) AND a one-time NATIVE scheduled task is written (~/.claude/scheduled-tasks/<id>/
//     SKILL.md + an entry with fireAt/enabled in the desktop app's central registry). The future
//     session claims via start_task (which overrides not_ready), runs the prompt, completes.
//   - disruptive:true (any `when`) → never auto-fires. A severity-'review' guidance item queues
//     for the user (review never pauses the loop) carrying action {kind:'follow-up', task_key};
//     the node stays not_ready until /guidance/resolve answers approve (release) / reject (cancel).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const overlay = require('./overlay');

// Validate a follow_ups payload. Returns an error string if invalid, or null if OK (mirrors
// validateMetricSpec/validateBenchmark in daemon.js). Required per item: title + prompt (strings).
// `when` (optional) must be "asap" or an ISO 8601 timestamp Date.parse accepts; `disruptive`
// (optional) must be a boolean.
function validate(arr) {
  if (!Array.isArray(arr)) return 'follow_ups must be an array';
  for (const f of arr) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) return 'each follow_up must be an object';
    if (!f.title || typeof f.title !== 'string') return 'each follow_up needs a title (string)';
    if (!f.prompt || typeof f.prompt !== 'string') return 'each follow_up needs a prompt (string, self-contained instructions)';
    if (f.when != null && f.when !== 'asap' && (typeof f.when !== 'string' || Number.isNaN(Date.parse(f.when))))
      return `follow_up "${f.title}": when must be "asap" or an ISO 8601 timestamp`;
    if (f.disruptive != null && typeof f.disruptive !== 'boolean') return `follow_up "${f.title}": disruptive must be a boolean`;
  }
  return null;
}

// Mint a collision-free overlay task key for a follow-up: 'followup/<kebab-title>-<rand>'.
// The pseudo-session prefix 'followup' never exists under ~/.claude/tasks, so the snapshot node
// is always served by aggregateWorkspace and native write-through stays a harmless no-op.
function mintKey(ov, title) {
  const slug = String(title).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40) || 'follow-up';
  let key;
  do { key = `followup/${slug}-${Math.random().toString(36).slice(2, 6)}`; } while (ov.snapshots && ov.snapshots[key]);
  return key;
}

// Apply validated follow_ups to the overlay when `parentKey` completes (pure overlay mutation —
// caller persists). Per item: create the snapshot-backed task node (description = the prompt),
// wire a context edge parent → follow-up (the parent's summary flows in as Tier-1 context), and
// route. Returns [{ key, title, prompt, routing: 'ready'|'scheduled'|'gated', when?, fireAt?,
// guidance_id? }] — the daemon writes native scheduled tasks for the 'scheduled' ones (fs side
// effect kept out of here so this stays unit-testable).
function apply(ov, parentKey, items, nowMs = Date.now()) {
  const results = [];
  for (const f of items) {
    const key = mintKey(ov, f.title);
    overlay.setSnapshot(ov, key, { subject: f.title, description: f.prompt, status: 'pending', blockedBy: [], owner: null, metadata: { follow_up_of: parentKey, created_by: 'daemon' } });
    overlay.addEdge(ov, parentKey, key, null, 'context');
    const ts = (f.when && f.when !== 'asap') ? Date.parse(f.when) : null;
    if (f.disruptive === true) {
      const gid = overlay.addGuidance(ov, {
        question: f.title,
        context: `${f.prompt}${f.when ? `\n\nProposed timing: ${f.when}` : ''}`,
        trigger: 'follow_up',
        severity: 'review', // queues for the user WITHOUT pausing the loop
        action: { kind: 'follow-up', task_key: key, when: f.when || null },
      });
      overlay.setStatus(ov, key, 'not_ready', `disruptive follow-up: gated on guidance ${gid}`);
      results.push({ key, title: f.title, prompt: f.prompt, routing: 'gated', guidance_id: gid });
    } else if (ts != null && ts > nowMs) {
      overlay.setStatus(ov, key, 'not_ready', `scheduled for ${f.when} via native scheduled task`);
      results.push({ key, title: f.title, prompt: f.prompt, routing: 'scheduled', when: f.when, fireAt: ts });
    } else {
      // asap / no when / already-past timestamp: leave it to derive 'ready' — the loop drains it.
      results.push({ key, title: f.title, prompt: f.prompt, routing: 'ready' });
    }
  }
  return results;
}

// Act on a follow-up guidance answer (the release-on-approval hook /guidance/resolve calls):
// 'approve' → drop the not_ready override so the node re-derives READY (the loop picks it up);
// 'reject' → cancel it (terminal) + raise the cooperative cancel flag. Any other answer returns
// null — the text is recorded by the caller and the task stays gated. Pure overlay mutation.
function resolveGate(ov, action, decision) {
  const tk = action && action.task_key;
  if (!tk) return null;
  if (decision === 'approve') { delete ov.status[tk]; return { decision: 'approve', released: tk }; }
  if (decision === 'reject') {
    overlay.setStatus(ov, tk, 'canceled', 'follow-up rejected via guidance');
    ov.cancel_requested[tk] = new Date().toISOString();
    return { decision: 'reject', canceled: tk };
  }
  return null;
}

// Find the desktop app's central scheduled-task registry (where fireAt + enabled actually live —
// the SKILL.md frontmatter carries only name/description). Observed location:
//   ~/Library/Application Support/Claude/claude-code-sessions/<uuid>/<uuid>/scheduled-tasks.json
// Glob two levels; if several exist pick the most recently modified. Returns a path or null.
function findRegistry(appSupportDir) {
  const base = path.join(appSupportDir, 'Claude', 'claude-code-sessions');
  let best = null, bestM = -1;
  let l1; try { l1 = fs.readdirSync(base); } catch { return null; }
  for (const a of l1) {
    let l2; try { l2 = fs.readdirSync(path.join(base, a)); } catch { continue; }
    for (const b of l2) {
      const p = path.join(base, a, b, 'scheduled-tasks.json');
      try { const m = fs.statSync(p).mtimeMs; if (m > bestM) { best = p; bestM = m; } } catch { /* not here */ }
    }
  }
  return best;
}

// Write a ONE-TIME native scheduled task for a timed follow-up: the SKILL.md instruction file
// under <claudeDir>/scheduled-tasks/<id>/ plus an armed entry ({ id, fireAt, enabled, filePath,
// createdAt, cwd } — exactly the registry's observed shape) appended to the central registry.
// `claudeDir`/`appSupportDir` are injectable for tests (default: the real ~/.claude / app support).
// Never throws: returns { ok, skillPath?, armed, registryPath?, note?/error? }. If the registry
// can't be found the SKILL.md is still written and armed:false says timing must be armed manually.
// Known limitation (documented, not solved): daemon-written scheduled tasks have no stored tool
// approvals, so a first unattended run may pause on permission prompts.
function writeScheduledTask({ id, title, prompt, taskKey, when, fireAt, cwd, claudeDir, appSupportDir }) {
  try {
    const cd = claudeDir || path.join(os.homedir(), '.claude');
    const dir = path.join(cd, 'scheduled-tasks', id);
    fs.mkdirSync(dir, { recursive: true });
    const skillPath = path.join(dir, 'SKILL.md');
    const desc = `One-time orchestrator follow-up (auto-created): ${title}`.replace(/\s+/g, ' ').slice(0, 200);
    const body = `---
name: ${id}
description: ${desc}
---

One-time follow-up auto-created by the orchestrator daemon (workspace ${cwd}) when graph task "${taskKey.startsWith('followup/') ? taskKey : taskKey}" was scheduled. Scheduled for ${when}.

1. Claim the graph task: orchestrator MCP tool \`start_task\` with task_key "${taskKey}" (daemon on http://localhost:8787). Its not_ready override exists only to keep the heartbeat loop from firing it early — claiming via start_task overrides it.
2. Execute the follow-up:

${prompt}

3. Report back: \`complete_task\` with task_key "${taskKey}" and a tight summary.

Known limitation: this scheduled task was written by the daemon, so it has no stored tool approvals — a first unattended run may pause on permission prompts.
`;
    const tmp = `${skillPath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, skillPath);
    // Arm the schedule: append to the app's central registry (read-modify-write, atomic rename).
    const reg = findRegistry(appSupportDir || path.join(os.homedir(), 'Library', 'Application Support'));
    if (!reg) return { ok: true, skillPath, armed: false, note: 'scheduled-task registry not found — SKILL.md written, arm the fireAt manually (e.g. via the schedule skill)' };
    const data = JSON.parse(fs.readFileSync(reg, 'utf8'));
    if (!Array.isArray(data.scheduledTasks)) data.scheduledTasks = [];
    data.scheduledTasks.push({ id, fireAt, enabled: true, filePath: skillPath, createdAt: Date.now(), cwd });
    const rtmp = `${reg}.${process.pid}.tmp`;
    fs.writeFileSync(rtmp, JSON.stringify(data, null, 2));
    fs.renameSync(rtmp, reg);
    return { ok: true, skillPath, armed: true, registryPath: reg };
  } catch (e) {
    return { ok: false, armed: false, error: `scheduled-task write failed: ${e.message}` };
  }
}

module.exports = { validate, apply, resolveGate, writeScheduledTask, findRegistry, mintKey };
