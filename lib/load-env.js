'use strict';
/**
 * load-env.js — dependency-free .env loader (no `dotenv` package; matches this repo's no-deps style).
 *
 * Reads KEY=VALUE lines from <root>/.env.local then <root>/.env and merges them into process.env
 * WITHOUT overriding values already present — the real environment always wins, and `.env.local`
 * wins over `.env`. This is how locally-run scripts (e.g. the headless Claude CLI the onboarding
 * learner spawns) pick up secrets like ANTHROPIC_API_KEY without the key ever living in source.
 *
 * Both files are gitignored. In Docker, do NOT bake keys into the image — inject the same vars at
 * `docker run` time (e.g. `--env-file .env.local` or `-e ANTHROPIC_API_KEY=…`).
 *
 * Parsing: `#` comments and blank lines are skipped; a leading `export ` is tolerated; matching
 * surrounding quotes are stripped; an inline ` # comment` is removed only from unquoted values;
 * the value is split on the FIRST `=` so tokens containing `=` survive.
 */
const fs = require('fs');
const path = require('path');

function parseEnv(text) {
  const out = {};
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    const m = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(line);
    if (!m) continue;
    let val = m[2];
    const quoted = (val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"));
    if (!quoted) val = val.replace(/\s+#.*$/, '').trim();           // strip trailing inline comment (unquoted only)
    if (quoted) val = val.slice(1, -1);                              // strip matching surrounding quotes
    out[m[1]] = val;
  }
  return out;
}

// Load the given files (first = highest precedence) from rootDir into process.env, never
// overriding an existing value. Returns the list of keys actually set (for optional logging).
function loadEnvFiles(rootDir, files = ['.env.local', '.env']) {
  const setKeys = [];
  for (const f of files) {
    let text;
    try { text = fs.readFileSync(path.join(rootDir, f), 'utf8'); } catch { continue; }
    for (const [k, v] of Object.entries(parseEnv(text))) {
      if (process.env[k] === undefined) { process.env[k] = v; setKeys.push(k); }
    }
  }
  return setKeys;
}

module.exports = { loadEnvFiles, parseEnv };
