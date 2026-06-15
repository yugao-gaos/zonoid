'use strict';

function formatDate(date, format) {
  const d = new Date(date);
  const pad = n => String(n).padStart(2, '0');
  return format
    .replace('YYYY', d.getFullYear())
    .replace('MM', pad(d.getMonth() + 1))
    .replace('DD', pad(d.getDate()));
}

function truncate(str, maxLen, suffix) {
  if (typeof suffix === 'undefined') suffix = '...';
  if (str.length <= maxLen) return str;
  return str.slice(0, maxLen - suffix.length) + suffix;
}

function deepMerge(target, source) {
  const result = Object.assign({}, target);
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      result[key] = deepMerge(result[key] || {}, source[key]);
    } else {
      result[key] = source[key];
    }
  }
  return result;
}

module.exports = { formatDate, truncate, deepMerge };
