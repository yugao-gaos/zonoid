// Hookless harness scheduler: armWakeup/cancelWakeup via lib/schedule-wakeup.js;
// writeScheduledTask writes a deferred NOTE.md under the runtime data dir's scheduled-tasks/<id>/
// and arms via armWakeup when session is provided.
'use strict';
const fs = require('fs');
const path = require('path');
const sw = require('../schedule-wakeup');
const runtimePaths = require('../runtime-paths');

function armWakeup(opts) {
  return sw.armWakeup(opts || {});
}

function cancelWakeup(opts) {
  const session = typeof opts === 'string' ? opts : opts?.session;
  return sw.cancelWakeup(session);
}

function formatFollowUpPrompt({ title, prompt, taskKey, when, cwd }) {
  return `One-time orchestrator follow-up (auto-created): ${title}

Scheduled for ${when} (workspace ${cwd}).

1. Claim the graph task: orchestrator MCP tool \`start_task\` with task_key "${taskKey}".
2. Execute the follow-up:

${prompt}

3. Report back: \`complete_task\` with task_key "${taskKey}" and a tight summary.`;
}

function writeScheduledTask({ id, title, prompt, taskKey, when, fireAt, cwd, session, orchDir }) {
  try {
    const dir = orchDir
      ? path.join(orchDir, 'scheduled-tasks', id)
      : runtimePaths.runtimePath('scheduled-tasks', id);
    fs.mkdirSync(dir, { recursive: true });
    const notePath = path.join(dir, 'NOTE.md');
    const body = formatFollowUpPrompt({ title, prompt, taskKey, when, cwd });
    const tmp = `${notePath}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body);
    fs.renameSync(tmp, notePath);

    if (session && fireAt) {
      const delay = Math.max(0, Math.floor((fireAt - Date.now()) / 1000));
      const arm = armWakeup({
        session,
        delaySeconds: delay,
        reason: `scheduled follow-up ${id}`,
        prompt: body,
      });
      if (arm.ok) {
        return { ok: true, notePath, armed: true, pid: arm.pid, delaySeconds: arm.delaySeconds };
      }
      return {
        ok: true,
        notePath,
        armed: false,
        note: `deferred — arm failed: ${arm.error}`,
        error: arm.error,
      };
    }
    return {
      ok: true,
      notePath,
      armed: false,
      note: 'no session — deferred note written; arm via ScheduleWakeup when session is live',
    };
  } catch (e) {
    return { ok: false, armed: false, error: `scheduled-task write failed: ${e.message}` };
  }
}

module.exports = { armWakeup, cancelWakeup, writeScheduledTask };
