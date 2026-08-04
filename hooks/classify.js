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

  // --- 'orch auto' / 'orch auto off': atomic per-workspace full-autonomy toggle ---------------
  // Expands server-side (POST /config { auto }) to self_plan + automode + headless_driver so the
  // hook, the dashboard toggle, and curl all share one code path. Match the 'off' form first —
  // the bare 'orch auto' pattern would otherwise also match 'orch auto off'.
  const autoOff = /(^|\s)@?orch\s+auto\s+off(?=\s|$|[^a-z0-9])/.test(low);
  const autoOn = !autoOff && /(^|\s)@?orch\s+auto(?=\s|$|[^a-z0-9])/.test(low);
  if (autoOn || autoOff) {
    // Lazy requires: only loaded when the toggle actually fires, keeping the per-prompt hot path
    // free of the heavier lib modules.
    const { repoRoot } = require('../lib/workspace-registry');
    const ws = repoRoot(input.cwd || process.cwd());
    if (!ws) k.emitContext('UserPromptSubmit', '[Orchestrator] orch auto: cwd is not inside a repo — no workspace resolved, nothing toggled.');
    const respText = await k.post('/config', { workspace: ws, auto: autoOn }, 2000);
    let resp = null;
    try { resp = JSON.parse(respText); } catch { resp = null; }
    const cfg = resp && resp.config;
    if (!cfg) k.emitContext('UserPromptSubmit', `[Orchestrator] orch auto ${autoOn ? 'on' : 'off'} FAILED — daemon unreachable, config unchanged.`);
    const flags = `self_plan=${!!cfg.self_plan} automode=${!!cfg.automode} headless_driver=${!!cfg.headless_driver}`;
    if (autoOn) {
      const { AUTOSTART_CONFIG } = require('../lib/loop-autostart');
      const { effectiveConfig } = require('../lib/headless-drain');
      const { dailyTokenBudget } = require('../lib/autonomy-budget');
      const drainCfg = effectiveConfig();
      // The per-boot drain token cap is opt-in (unbounded unless set), so only mention it when it
      // is actually armed — the standing bound to report is the per-workspace DAILY ceiling.
      const perBoot = Number.isFinite(drainCfg.tokenBudget) ? `${drainCfg.tokenBudget} tokens per daemon boot / ` : '';
      const daily = dailyTokenBudget({ config: cfg });
      k.emitContext('UserPromptSubmit',
        `[Orchestrator] Full autonomy ON for ${resp.workspace || ws} (${flags}). The daemon now plans on a drained DAG (self_plan), executes spawn/plan/optimize + review verdicts headlessly (headless_driver), and auto-answers escalations + auto-merges approved attempts (automode). ` +
        `Budget caps: ${daily > 0 ? `${daily} autonomy tokens per day (resets at midnight)` : 'daily autonomy ceiling DISABLED'}; managed loop ${AUTOSTART_CONFIG.tokenBudget} tokens / ${AUTOSTART_CONFIG.maxIterations} iterations / batch ${AUTOSTART_CONFIG.batch} / ${AUTOSTART_CONFIG.maxConcurrency} concurrent workers; headless drains ${perBoot}${drainCfg.maxConcurrency} concurrent drain children. Disable with "orch auto off".`);
    }
    k.emitContext('UserPromptSubmit',
      `[Orchestrator] Full autonomy OFF for ${resp.workspace || ws} (${flags}). Headless spawn/plan/review drains stand down; interactive dispatch resumes. Re-enable with "orch auto".`);
  }

  if (k.isOff(sid)) k.allow();          // opted out -> no classify

  const body = { prompt };
  if (sid) body.session_id = sid;
  const pm = input.permission_mode || input.permissionMode || '';
  if (pm) body.permission_mode = pm;
  const autoMode = input.auto_mode ?? input.autoMode;
  if (autoMode != null) body.auto_mode = autoMode;
  if (input.capabilities && typeof input.capabilities === 'object') body.capabilities = input.capabilities;
  if (process.env.ORCH_AUTO_LOOP === '1') body.auto_loop_env = true;
  if (process.env.ORCH_GATE_OFF === '1') body.orch_gate_off = true;

  const respText = await k.post('/classify', body, 2000);
  let ctx = '';
  try { ctx = (JSON.parse(respText) || {}).additional_context || ''; } catch { ctx = ''; }
  if (!ctx) k.allow();
  k.emitContext('UserPromptSubmit', ctx);
})().catch(() => process.exit(0));
