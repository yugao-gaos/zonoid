'use strict';

const fs = require('fs');

function parseTranscript(filePath) {
  const lines = fs.readFileSync(filePath, 'utf8').split('\n');
  let gross = 0;
  let mcpOverhead = 0;
  let output = 0;

  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (!obj.usage) continue;

    const u = obj.usage;
    const tokens =
      (u.input_tokens || 0) +
      (u.output_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);

    gross += tokens;
    output += u.output_tokens || 0;

    if (obj.source === 'mcp_tool') {
      mcpOverhead += tokens;
    }
  }

  return { gross, net: gross - mcpOverhead, output };
}

function ratio(on, off) {
  if (off === 0) return null;
  return Math.round((on / off) * 10000) / 10000;
}

function computeRatio(onTranscript, offTranscript) {
  const on = parseTranscript(onTranscript);
  const off = parseTranscript(offTranscript);
  return {
    gross: ratio(on.gross, off.gross),
    net: ratio(on.net, off.net),
    output: ratio(on.output, off.output),
  };
}

module.exports = { computeRatio };
