#!/usr/bin/env node
// Static regressions for graph.html settings/config fetch behavior.
'use strict';

const fs = require('fs');
const path = require('path');

let pass = 0; let fail = 0;
const ok = (label, cond) => {
  if (cond) { console.log(`PASS  ${label}`); pass++; }
  else { console.log(`FAIL  ${label}`); fail++; }
};

const html = fs.readFileSync(path.join(__dirname, '..', 'public', 'graph.html'), 'utf8');

ok('settings save no longer references undefined loadData', !html.includes('setInterval(loadData'));
ok('settings save schedules tick polling', html.includes('setInterval(tick, interval*1000)'));
ok('saved daemonUrl initializes mutable BASE', html.includes('let BASE = loadSavedDaemonUrl() || DEFAULT_BASE'));
ok('settings save refreshes mutable BASE', html.includes('setDaemonBase(url);'));
ok('workspace discovery uses token-aware dfetch',
  !html.includes("fetch(BASE + '/workspaces')") && (html.match(/dfetch\('\/workspaces'\)/g) || []).length >= 2);
ok('backend provider rows surface default model metadata', html.includes("default '+prov.defaultModel"));
ok('backend model selector is a dropdown, not a textbox',
  html.includes('<select class="spinput" id="bk-model"></select>') && !html.includes('id="bk-model" type="text"'));
ok('backend model selector is populated from provider supportedModels',
  html.includes('function bkModelOptions(prov, activeModel)') && html.includes('prov.supportedModels'));
ok('backend API key status uses a colored dot and delete button',
  html.includes('id="bk-key-dot"') && html.includes('id="bk-key-delete"') && html.includes('function deleteBackendKey()'));
ok('backend API key delete calls DELETE /config/backend/key',
  html.includes("method:'DELETE'") && html.includes("dfetch('/config/backend/key'"));
ok('orch auto toggle present in Settings next to Full Automode',
  html.includes('id="sp-orchauto"') && html.includes('Orch Auto (full autonomy)'));
ok('orch auto toggle posts the atomic auto field (one server-side code path)',
  html.includes('JSON.stringify({auto:on})'));
ok('orch auto mixed state shows an honest partial hint',
  html.includes('id="sp-orchauto-partial"') && html.includes('partial: some flags on'));

console.log('-----');
console.log(`${pass} passed, ${fail} failed`);
process.exit(fail === 0 ? 0 : 1);
