#!/usr/bin/env node
'use strict';

const http = require('http');

function usage() {
  console.error('usage: node scripts/reembed-embeddings.js --workspace <path> --provider <id> [--model <id>] [--dimensions <n>] [--adapter <id>] [--tuned-model-id <id>] [--port <n>] [--dry-run] [--no-reembed]');
}

function parseArgs(argv) {
  const out = { port: Number(process.env.PORT || 8787), reembed: true };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => argv[++i];
    if (a === '--workspace') out.workspace = next();
    else if (a === '--provider') out.provider = next();
    else if (a === '--model') out.model = next();
    else if (a === '--dimensions') out.dimensions = Number(next());
    else if (a === '--adapter') out.adapter = next();
    else if (a === '--tuned-model-id') out.tuned_model_id = next();
    else if (a === '--modality') out.modality = next();
    else if (a === '--base-url') out.baseUrl = next();
    else if (a === '--api-style') out.apiStyle = next();
    else if (a === '--port') out.port = Number(next());
    else if (a === '--dry-run') out.dry_run = true;
    else if (a === '--no-reembed') out.reembed = false;
    else if (a === '-h' || a === '--help') out.help = true;
    else throw new Error(`unknown argument: ${a}`);
  }
  return out;
}

function postJson(port, path, body) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const req = http.request({
      host: '127.0.0.1',
      port,
      path,
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) },
    }, (res) => {
      let s = '';
      res.on('data', (d) => { s += d; });
      res.on('end', () => {
        let parsed = null;
        try { parsed = s ? JSON.parse(s) : null; } catch { /* preserve raw body */ }
        resolve({ status: res.statusCode, body: parsed || s });
      });
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

(async () => {
  let args;
  try { args = parseArgs(process.argv.slice(2)); } catch (e) {
    console.error(e.message);
    usage();
    process.exit(2);
  }
  if (args.help) { usage(); process.exit(0); }
  if (!args.workspace || !args.provider) { usage(); process.exit(2); }
  const { port, ...body } = args;
  const res = await postJson(port, '/overlay/embedding-provider/swap', body);
  console.log(JSON.stringify(res.body, null, 2));
  process.exit(res.status >= 200 && res.status < 300 && res.body && res.body.ok ? 0 : 1);
})().catch((err) => {
  console.error(err && err.stack ? err.stack : err);
  process.exit(1);
});
