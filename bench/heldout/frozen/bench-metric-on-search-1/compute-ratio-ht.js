'use strict';

const fs = require('fs');

function sumTranscript(filePath) {
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
    const lineTotal =
      (u.input_tokens || 0) +
      (u.output_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);

    gross += lineTotal;
    output += u.output_tokens || 0;

    if (obj.source === 'mcp_tool') {
      mcpOverhead += lineTotal;
    }
  }

  return { gross, net: gross - mcpOverhead, output };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function ratio(on, off) {
  return off === 0 ? null : round4(on / off);
}

function computeRatio(onTranscript, offTranscript) {
  const on = sumTranscript(onTranscript);
  const off = sumTranscript(offTranscript);

  return {
    gross:  ratio(on.gross,  off.gross),
    net:    ratio(on.net,    off.net),
    output: ratio(on.output, off.output),
  };
}

module.exports = { computeRatio };
