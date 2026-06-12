'use strict';

const fs = require('fs');

function sumUsage(lines) {
  let gross = 0, plumbing = 0, output = 0;

  for (const line of lines) {
    let obj;
    try { obj = JSON.parse(line); } catch { continue; }

    if (!obj.usage) continue;

    const u = obj.usage;
    const total =
      (u.input_tokens || 0) +
      (u.output_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);

    gross += total;
    output += (u.output_tokens || 0);

    if (obj.source === 'mcp_tool') {
      plumbing += total;
    }
  }

  return { gross, net: gross - plumbing, output };
}

function computeRatio(onTranscript, offTranscript) {
  const onLines = fs.readFileSync(onTranscript, 'utf8').split('\n');
  const offLines = fs.readFileSync(offTranscript, 'utf8').split('\n');

  const on = sumUsage(onLines);
  const off = sumUsage(offLines);

  function ratio(num, den) {
    if (den === 0) return null;
    return Math.round((num / den) * 10000) / 10000;
  }

  return {
    gross:  ratio(on.gross,  off.gross),
    net:    ratio(on.net,    off.net),
    output: ratio(on.output, off.output),
  };
}

module.exports = { computeRatio };
