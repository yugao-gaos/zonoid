#!/usr/bin/env node
'use strict';
// Status line: latest routing decision + live subagent counts + web-view link. Reads daemon /state;
// degrades gracefully if the daemon is down. Node port of statusline.sh. (No stdin.)
const k = require('./lib/hookkit');

(async () => {
  const state = await k.getJson('/state', 400);
  if (!state) { process.stdout.write('🕸 orchestrator: daemon down'); process.exit(0); }
  const s = state.summary || {};
  const route = (s.lastRoute && s.lastRoute.decision) || '—';
  const a = s.agents || {};
  const running = a.running != null ? a.running : 0;
  const done = a.done != null ? a.done : 0;
  const total = a.total != null ? a.total : 0;
  // OSC 8 clickable link (iTerm2/Kitty/WezTerm; harmless elsewhere). ESC=0x1b, ST=ESC backslash.
  const ESC = String.fromCharCode(27);
  const bs = String.fromCharCode(92); // backslash
  const link = ESC + ']8;;http://localhost:' + k.PORT + '/graph' + ESC + bs + 'graph' + ESC + ']8;;' + ESC + bs;
  let icon = '·';
  if (route === 'workflow') icon = '⚙';
  else if (route === 'team') icon = '👥';
  else if (route === 'solo') icon = '•';
  process.stdout.write(`🕸 route ${icon} ${route} · agents ${running}▶/${done}✓ (${total}) · ${link}`);
  process.exit(0);
})().catch(() => process.exit(0));
