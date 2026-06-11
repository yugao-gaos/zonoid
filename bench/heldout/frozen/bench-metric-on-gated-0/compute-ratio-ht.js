const fs = require('fs');

function sumUsage(u) {
  if (!u) return 0;
  return (
    (u.input_tokens || 0) +
    (u.output_tokens || 0) +
    (u.cache_read_input_tokens || 0) +
    (u.cache_creation_input_tokens || 0)
  );
}

function readMetrics(path) {
  const text = fs.readFileSync(path, 'utf8');
  let gross = 0;
  let mcp = 0;
  let output = 0;

  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    let obj;
    try {
      obj = JSON.parse(trimmed);
    } catch (e) {
      continue; // skip non-JSON lines silently
    }

    if (!obj || !obj.usage) continue;

    const total = sumUsage(obj.usage);
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
  const on = readMetrics(onTranscript);
  const off = readMetrics(offTranscript);

  return {
    gross: ratio(on.gross, off.gross),
    net: ratio(on.net, off.net),
    output: ratio(on.output, off.output),
  };
}

module.exports = { computeRatio };
