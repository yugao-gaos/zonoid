'use strict';

const fs = require('fs');

function sumUsage(lines) {
  let gross = 0;
  let mcpGross = 0;
  let output = 0;

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

    if (obj.source === 'mcp_tool') {
      mcpGross += lineTotal;
    }
  }

  return { gross, net: gross - mcpGross, output };
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function computeRatio(onTranscript, offTranscript) {
  const onLines  = fs.readFileSync(onTranscript,  'utf8').split('\n');
  const offLines = fs.readFileSync(offTranscript, 'utf8').split('\n');

  const on  = sumUsage(onLines);
  const off = sumUsage(offLines);

  return {
    gross:  off.gross  === 0 ? null : round4(on.gross  / off.gross),
    net:    off.net    === 0 ? null : round4(on.net    / off.net),
    output: off.output === 0 ? null : round4(on.output / off.output),
  };
}

module.exports = { computeRatio };
