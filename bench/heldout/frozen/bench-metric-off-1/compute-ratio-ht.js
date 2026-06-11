const fs = require('fs');

function metricsFor(path) {
  let gross = 0;
  let mcp = 0;
  let output = 0;

  const lines = fs.readFileSync(path, 'utf8').split('\n');
  for (const line of lines) {
    if (!line.trim()) continue;
    let obj;
    try {
      obj = JSON.parse(line);
    } catch (e) {
      continue; // not valid JSON — skip silently
    }
    const u = obj && obj.usage;
    if (!u) continue;

    const sum =
      (u.input_tokens || 0) +
      (u.output_tokens || 0) +
      (u.cache_read_input_tokens || 0) +
      (u.cache_creation_input_tokens || 0);

    gross += sum;
    output += u.output_tokens || 0;
    if (obj.source === 'mcp_tool') mcp += sum;
  }

  return { gross, net: gross - mcp, output };
}

function ratio(on, off) {
  if (off === 0) return null;
  return Math.round((on / off) * 1e4) / 1e4;
}

function computeRatio(onTranscript, offTranscript) {
  const on = metricsFor(onTranscript);
  const off = metricsFor(offTranscript);

  return {
    gross: ratio(on.gross, off.gross),
    net: ratio(on.net, off.net),
    output: ratio(on.output, off.output),
  };
}

module.exports = { computeRatio };
