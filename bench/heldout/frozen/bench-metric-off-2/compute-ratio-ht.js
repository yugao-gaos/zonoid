const fs = require('fs');

function parseTranscript(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let gross = 0, plumbing = 0, output = 0;

  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj.usage) continue;

    const { input_tokens = 0, output_tokens = 0, cache_read_input_tokens = 0, cache_creation_input_tokens = 0 } = obj.usage;
    const total = input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens;

    gross += total;
    output += output_tokens;

    if (obj.source === 'mcp_tool') {
      plumbing += total;
    }
  }

  return { gross, net: gross - plumbing, output };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function computeRatio(onTranscript, offTranscript) {
  const on = parseTranscript(onTranscript);
  const off = parseTranscript(offTranscript);

  return {
    gross:  off.gross  === 0 ? null : round4(on.gross  / off.gross),
    net:    off.net    === 0 ? null : round4(on.net    / off.net),
    output: off.output === 0 ? null : round4(on.output / off.output),
  };
}

module.exports = { computeRatio };
