const fs = require('fs');

const USAGE_FIELDS = [
  'input_tokens',
  'output_tokens',
  'cache_read_input_tokens',
  'cache_creation_input_tokens',
];

function lineTotal(usage) {
  let sum = 0;
  for (const field of USAGE_FIELDS) {
    sum += usage[field] || 0;
  }
  return sum;
}

function computeMetrics(path) {
  const content = fs.readFileSync(path, 'utf8');
  let gross = 0;
  let mcp = 0;
  let output = 0;

  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      continue; // skip non-JSON lines
    }

    if (!obj || !obj.usage) continue;

    const total = lineTotal(obj.usage);
    gross += total;
    output += obj.usage.output_tokens || 0;
    if (obj.source === 'mcp_tool') {
      mcp += total;
    }
  }

  return { gross, net: gross - mcp, output };
}

function ratio(on, off) {
  if (off === 0) return null;
  return Math.round((on / off) * 10000) / 10000;
}

function computeRatio(onTranscript, offTranscript) {
  const on = computeMetrics(onTranscript);
  const off = computeMetrics(offTranscript);

  return {
    gross: ratio(on.gross, off.gross),
    net: ratio(on.net, off.net),
    output: ratio(on.output, off.output),
  };
}

module.exports = { computeRatio };
