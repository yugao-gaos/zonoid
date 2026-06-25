'use strict';
const fs = require('fs');

function sumTokens(lines) {
  let gross = 0, mcp = 0, output = 0;
  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }
    if (!obj.usage) continue;
    const { input_tokens = 0, output_tokens = 0, cache_read_input_tokens = 0, cache_creation_input_tokens = 0 } = obj.usage;
    const total = input_tokens + output_tokens + cache_read_input_tokens + cache_creation_input_tokens;
    gross += total;
    output += output_tokens;
    if (obj.source === 'mcp_tool') mcp += total;
  }
  return { gross, net: gross - mcp, output };
}

function computeRatio(onTranscript, offTranscript) {
  const onLines  = fs.readFileSync(onTranscript,  'utf8').split('\n');
  const offLines = fs.readFileSync(offTranscript, 'utf8').split('\n');
  const on  = sumTokens(onLines);
  const off = sumTokens(offLines);

  function ratio(n, d) {
    if (d === 0) return null;
    return Math.round((n / d) * 10000) / 10000;
  }

  return {
    gross:  ratio(on.gross,  off.gross),
    net:    ratio(on.net,    off.net),
    output: ratio(on.output, off.output),
  };
}

module.exports = { computeRatio };
