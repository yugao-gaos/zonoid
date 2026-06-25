'use strict';
const fs = require('fs');

function sumTranscript(lines) {
  let gross = 0, mcpOverhead = 0, output = 0;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    const u = obj.usage;
    if (!u) continue;
    const lineTotal =
      (u.input_tokens || 0) +
      (u.output_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);
    gross += lineTotal;
    output += (u.output_tokens || 0);
    if (obj.source === 'mcp_tool') mcpOverhead += lineTotal;
  }
  return { gross, net: gross - mcpOverhead, output };
}

function computeRatio(onTranscript, offTranscript) {
  const onLines  = fs.readFileSync(onTranscript,  'utf8').split('\n');
  const offLines = fs.readFileSync(offTranscript, 'utf8').split('\n');
  const on  = sumTranscript(onLines);
  const off = sumTranscript(offLines);

  function ratio(a, b) {
    if (b === 0) return null;
    return Math.round((a / b) * 10000) / 10000;
  }

  return {
    gross:  ratio(on.gross,  off.gross),
    net:    ratio(on.net,    off.net),
    output: ratio(on.output, off.output),
  };
}

module.exports = { computeRatio };
