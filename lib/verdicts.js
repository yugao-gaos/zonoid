// Structured verdicts about EXISTING tasks: when complete_task carries a `verdicts` array, the
// daemon ACTS on each judgment instead of letting it evaporate as prose in the summary ("Recommend
// GO on /11" that nothing ever reads — the motivating incident). The follow_ups analogue for
// conclusions about tasks that already exist: follow_ups mint NEW work, verdicts release/hold/
// cancel/merge existing nodes. Pure overlay mutations — the caller persists (mirrors lib/followups.js).
//
// Per item ({ task_key, action, reason }):
//   - release: drop the target's explicit not_ready override so its status re-derives from deps;
//     the reason lands in its note. A target with no not_ready hold is a no-op (released:false).
//   - hold: set/refresh an explicit not_ready override with the reason as the note.
//   - cancel: existing cancel semantics — terminal status + cooperative cancel flag (the daemon
//     also snapshots the native fields, same as a direct /overlay/status cancel).
//   - merge: record a non-destructive merge request; the actual git merge stays with merge_attempt /
//     merge_feature, which have repo/worktree context and conflict handling.
//
// Also here: the STALE-HOLD guard (sweepStaleHolds) — on any completion, find explicit not_ready
// holds whose blocking deps are now all done; auto-release the ones whose hold note references the
// just-completed task, queue the rest as severity-'review' guidance ("release or re-justify") —
// and the PROSE-VERDICT lint (lintProse), a non-fatal nudge when a summary carries GO/recommend/
// unblock language about a task key with no structured verdict for it.
'use strict';
const overlay = require('./overlay');

const ACTIONS = ['release', 'hold', 'cancel', 'merge'];

// Validate a verdicts payload. Returns an error string if invalid, or null if OK (mirrors
// followups.validate). Required per item: task_key + reason (strings) and a known action.
function validate(arr) {
  if (!Array.isArray(arr)) return 'verdicts must be an array';
  for (const v of arr) {
    if (!v || typeof v !== 'object' || Array.isArray(v)) return 'each verdict must be an object';
    if (!v.task_key || typeof v.task_key !== 'string') return 'each verdict needs a task_key (string)';
    if (!ACTIONS.includes(v.action)) return `verdict "${v.task_key}": action must be "release", "hold", "cancel" or "merge"`;
    if (!v.reason || typeof v.reason !== 'string') return `verdict "${v.task_key}": needs a reason (string)`;
  }
  return null;
}

// Apply validated verdicts when `parentKey` completes (pure overlay mutation — caller persists).
// Returns [{ task_key, action, released?, note? }]; the daemon snapshots native fields for the
// 'cancel' ones (fs side effect kept out of here so this stays unit-testable).
function apply(ov, parentKey, items) {
  const results = [];
  for (const v of items) {
    const tk = v.task_key;
    if (v.action === 'release') {
      const held = ov.status[tk] === 'not_ready';
      if (held) delete ov.status[tk];
      // Reason FIRST so truncation can never eat the actionable part; prior note kept as history.
      const prior = ov.notes[tk];
      ov.notes[tk] = `released by ${parentKey}: ${v.reason}${prior ? ` (was: ${prior})` : ''}`.slice(0, 280);
      const r = { task_key: tk, action: 'release', released: held };
      if (!held) r.note = 'no explicit not_ready hold to release';
      results.push(r);
    } else if (v.action === 'hold') {
      overlay.setStatus(ov, tk, 'not_ready', `held by ${parentKey}: ${v.reason}`);
      results.push({ task_key: tk, action: 'hold' });
    } else if (v.action === 'cancel') { // same semantics as a direct cancel: terminal + cooperative flag
      overlay.setStatus(ov, tk, 'canceled', `canceled by ${parentKey}: ${v.reason}`);
      ov.cancel_requested[tk] = new Date().toISOString();
      results.push({ task_key: tk, action: 'cancel' });
    } else { // 'merge' (validated) — request only; git merge is handled by merge_attempt/merge_feature.
      const prior = ov.notes[tk];
      ov.notes[tk] = `merge requested by ${parentKey}: ${v.reason}${prior ? ` (was: ${prior})` : ''}`.slice(0, 280);
      results.push({ task_key: tk, action: 'merge', reason: v.reason, note: 'merge request recorded; no status changed' });
    }
  }
  return results;
}

// Does a hold note reference `taskKey`? Full key always counts. Sibling tasks also routinely
// reference each other by "/<id>" shorthand (the incident's hold note said "gated behind (/14)"),
// so the shorthand is honored ONLY when the held task shares the completed task's session — a bare
// "/14" can never match a task from another session.
function noteReferencesTask(note, taskKey, heldKey) {
  const n = String(note || '');
  if (!n) return false;
  if (n.includes(taskKey)) return true;
  const i = String(taskKey).lastIndexOf('/');
  if (i <= 0) return false;
  const session = taskKey.slice(0, i), id = taskKey.slice(i + 1);
  if (!String(heldKey).startsWith(session + '/')) return false;
  return new RegExp(`(^|[^\\w/])/${id}\\b`).test(n); // "/14" not glued to a path or another key
}

// Stale-hold guard, run on every completion: scan explicit not_ready overrides whose blocking deps
// (per the freshly built graph) are now ALL done. If the hold note references the just-completed
// task, the hold's stated justification is satisfied — auto-release, recording why. Otherwise do
// NOT silently release a hold we can't tie to this completion: queue a severity-'review' guidance
// ("release or re-justify", action {kind:'stale-hold', task_key}) for the user. Skips 'followup/'
// keys (their holds belong to the follow-ups gate/scheduler) and holds already re-justified via the
// gate. Dedup: a task with an unresolved stale-hold guidance is not re-flagged. Pure overlay
// mutation — caller persists. `graph` is buildGraph(ws) output ({ tasks, ghosts }).
function sweepStaleHolds(ov, completedKey, graph) {
  const byId = new Map((graph && graph.tasks ? graph.tasks : []).map((t) => [t.id, t]));
  const ghostDone = new Map((graph && graph.ghosts ? graph.ghosts : []).map((g) => [`ghost:${g.workspace}|${g.key}`, g.status === 'done']));
  const released = [], flagged = [];
  for (const [key, st] of Object.entries(ov.status || {})) {
    if (st !== 'not_ready' || key === completedKey) continue;
    if (key.startsWith('followup/')) continue; // gated/scheduled follow-up holds are structural, never "stale"
    const t = byId.get(key);
    if (!t || t.kind === 'note') continue;
    const note = ov.notes[key] || '';
    if (/^re-justified\b/i.test(note)) continue; // user re-affirmed this hold via the guidance gate
    const depsDone = (t.deps || []).every((d) => {
      const dt = byId.get(d);
      return dt ? dt.status === 'done' : (ghostDone.get(d) || false);
    });
    if (!depsDone) continue;
    if (noteReferencesTask(note, completedKey, key)) {
      delete ov.status[key];
      ov.notes[key] = `auto-released: hold referenced ${completedKey}, which completed (was: ${note})`.slice(0, 280);
      released.push(key);
    } else {
      if ((ov.guidance || []).some((g) => !g.resolved && g.action && g.action.kind === 'stale-hold' && g.action.task_key === key)) continue;
      const gid = overlay.addGuidance(ov, {
        question: `Stale hold on ${key} — release or re-justify`,
        context: `Every blocking dep of ${key} is done (latest completion: ${completedKey}) but it still carries an explicit not_ready hold${note ? ` ("${note}")` : ''} whose justification can't be tied to the completed task. Release it, or re-justify why it must stay held.`,
        trigger: 'stale_hold',
        severity: 'review', // queues for the user WITHOUT pausing the loop
        action: { kind: 'stale-hold', task_key: key, completed: completedKey },
      });
      flagged.push({ task_key: key, guidance_id: gid });
    }
  }
  return { released, flagged };
}

// Act on a stale-hold guidance answer (the /guidance/resolve hook): 'release' → drop the not_ready
// override so the task re-derives from deps; 'keep' → re-justify the hold (note stamped
// "re-justified: …" so the sweep stops re-flagging it). Any other answer returns null — the text is
// recorded by the caller and the hold stands. Pure overlay mutation (mirrors followups.resolveGate).
function resolveStaleHold(ov, action, decision, answer) {
  const tk = action && action.task_key;
  if (!tk) return null;
  if (decision === 'release') {
    if (ov.status[tk] === 'not_ready') delete ov.status[tk];
    ov.notes[tk] = `released: stale hold cleared via guidance${answer ? ` — ${answer}` : ''}`.slice(0, 280);
    return { decision: 'release', released: tk };
  }
  if (decision === 'keep') {
    overlay.setStatus(ov, tk, 'not_ready', `re-justified: ${answer || 'kept via guidance'}`);
    return { decision: 'keep', held: tk };
  }
  return null;
}

// Prose-verdict lint at complete_task time: if the summary pairs GO/recommend/unblock language with
// a task-key-like reference ("sess/11" or sibling shorthand "/11") that no structured verdict
// covers, return a non-fatal warning nudging `verdicts`. Returns null when clean. The completing
// task's own key/shorthand never counts as a reference (a summary may mention itself).
const VERDICT_LANG = /\bGO\b|\bNO[- ]?GO\b|recommend|unblock/i;
function lintProse(summary, verdictsArr, parentKey) {
  const s = String(summary || '');
  if (!VERDICT_LANG.test(s)) return null;
  const covered = new Set();
  const cover = (k) => { covered.add(k); const i = String(k).lastIndexOf('/'); if (i > 0) covered.add(String(k).slice(i)); };
  for (const v of (Array.isArray(verdictsArr) ? verdictsArr : [])) if (v && v.task_key) cover(v.task_key);
  if (parentKey) cover(parentKey);
  const refs = new Set();
  for (const m of s.match(/[A-Za-z0-9][\w-]{3,}\/\d+\b/g) || []) {
    if (/^\d+\//.test(m)) continue; // all-digit "session" = a date/fraction ("2026/06"), not a task key
    if (!covered.has(m)) refs.add(m);
  }
  for (const m of s.match(/(?:^|[\s("'`])\/\d+\b/g) || []) {
    const k = m.slice(m.indexOf('/'));
    if (!covered.has(k)) refs.add(k);
  }
  if (!refs.size) return null;
  return `verdict-in-prose: the summary references ${[...refs].join(', ')} with GO/recommend/unblock language but passes no structured verdict for ${refs.size > 1 ? 'them' : 'it'}. Nothing acts on prose — pass verdicts:[{task_key, action:"release"|"hold"|"cancel"|"merge", reason}] so the daemon enforces the verdict.`;
}

module.exports = { validate, apply, sweepStaleHolds, resolveStaleHold, lintProse, noteReferencesTask };
