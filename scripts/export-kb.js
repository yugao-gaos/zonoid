#!/usr/bin/env node
'use strict';

const http = require('http');

const PORT = process.env.ORCH_PORT || 8787;

function usage() {
  console.log('Usage: node export-kb.js --repo <path> [--k 30] [--min-score 0.1] [--format markdown|json] [--query <text>]');
  process.exit(1);
}

function has(flag) { return process.argv.includes(flag); }
function get(flag, def) {
  const i = process.argv.indexOf(flag);
  return i !== -1 && process.argv[i + 1] ? process.argv[i + 1] : def;
}

const repo = get('--repo', null);
if (!repo) usage();

const k = parseInt(get('--k', '30'), 10);
const minScore = parseFloat(get('--min-score', '0.1'));
const format = get('--format', 'markdown');
const query = get('--query', 'architecture conventions invariants gotchas decisions');

function search(workspace, q, topK) {
  return new Promise((resolve, reject) => {
    const qs = new URLSearchParams({ q, k: String(topK), workspace }).toString();
    const req = http.request(
      { hostname: 'localhost', port: PORT, path: `/search?${qs}`, method: 'GET' },
      (res) => {
        let body = '';
        res.on('data', (d) => body += d);
        res.on('end', () => {
          try { resolve(JSON.parse(body)); } catch { resolve({ results: [] }); }
        });
      }
    );
    req.on('error', reject);
    req.setTimeout(10000, () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function main() {
  let data;
  try {
    data = await search(repo, query, k);
  } catch (e) {
    console.error(`export-kb: daemon unreachable at localhost:${PORT} — ${e.message}`);
    process.exit(1);
  }

  const results = (data.results || []).filter(r => (r.score || 0) >= minScore);

  if (format === 'json') {
    console.log(JSON.stringify(results, null, 2));
    return;
  }

  if (!results.length) {
    process.stderr.write('export-kb: no KB notes found for this workspace\n');
    process.exit(0);
  }

  const lines = ['## Repository Knowledge Base (Zonoid)\n'];
  for (const r of results) {
    const kind = r.kind ? `[${r.kind}] ` : '';
    lines.push(`- **${kind}${r.title}**: ${r.summary}`);
  }
  lines.push('');
  console.log(lines.join('\n'));
}

main().catch(e => { console.error(e); process.exit(1); });
