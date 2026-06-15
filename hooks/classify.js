#!/usr/bin/env node
'use strict';
// UserPromptSubmit: per-conversation enable/disable toggle + prompt classification/context inject.
// Default ON; opt out with 'orch off' (re-enable 'orch on'). Cross-platform Node port of classify.sh
// (the old version shelled out to python3 just to build a JSON body — now a plain object).
const k = require('./lib/hookkit');

(async () => {
  const input = await k.readInput();
  const sid = input.session_id || input.conversation_id || input.sessionId || '';
  const prompt = input.prompt || '';
  if (sid) k.resetTrivialCounter(sid);

  const low = prompt.toLowerCase();
  if (/(^|\s)@?orch\s+on(?=\s|$|[^a-z0-9])/.test(low)) {
    k.clearOff(sid);
    k.emitContext('UserPromptSubmit', '[Orchestrator] Enabled (default) for this conversation. Prompts will be auto-routed and tasks tracked in the graph.');
  }
  if (/(^|\s)@?orch\s+off(?=\s|$|[^a-z0-9])/.test(low)) {
    k.setOff(sid);
    k.emitContext('UserPromptSubmit', '[Orchestrator] Disabled for this conversation.');
  }

  if (k.isOff(sid)) k.allow();          // opted out -> no classify

  const body = { prompt };
  if (sid) body.session_id = sid;
  const pm = input.permission_mode || input.permissionMode || '';
  if (pm) body.permission_mode = pm;
  if (process.env.ORCH_AUTO_LOOP === '1') body.auto_mode = true;
  if (process.env.ORCH_GATE_OFF === '1') body.orch_gate_off = true;

  const respText = await k.post('/classify', body, 2000);
  let ctx = '';
  try { ctx = (JSON.parse(respText) || {}).additional_context || ''; } catch { ctx = ''; }
  if (!ctx) k.allow();
  k.emitContext('UserPromptSubmit', ctx);
})().catch(() => process.exit(0));
