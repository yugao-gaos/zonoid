'use strict';
function parseConfig(s) {
  if (!s || !s.trim()) return {};
  const result = {};
  for (const line of s.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) throw new Error('invalid line: ' + trimmed);
    result[trimmed.slice(0, eq).trim()] = trimmed.slice(eq + 1).trim();
  }
  return result;
}
module.exports = { parseConfig };
