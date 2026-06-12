'use strict';

function parseField(field, min, max) {
  const values = new Set();

  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
    } else if (part.includes('/')) {
      const slash = part.indexOf('/');
      const range = part.slice(0, slash);
      const step = parseInt(part.slice(slash + 1), 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step: ${part}`);

      let start, end;
      if (range === '*') {
        start = min; end = max;
      } else if (range.includes('-')) {
        const dash = range.indexOf('-');
        start = parseInt(range.slice(0, dash), 10);
        end = parseInt(range.slice(dash + 1), 10);
      } else {
        start = parseInt(range, 10);
        end = max;
      }
      if (isNaN(start) || isNaN(end)) throw new Error(`Invalid range: ${part}`);
      if (start < min || end > max || start > end) throw new Error(`Out of range: ${part}`);
      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes('-')) {
      const dash = part.indexOf('-');
      const start = parseInt(part.slice(0, dash), 10);
      const end = parseInt(part.slice(dash + 1), 10);
      if (isNaN(start) || isNaN(end)) throw new Error(`Invalid range: ${part}`);
      if (start < min || end > max || start > end) throw new Error(`Out of range: ${part}`);
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      const val = parseInt(part, 10);
      if (isNaN(val)) throw new Error(`Invalid value: ${part}`);
      if (val < min || val > max) throw new Error(`Value ${val} out of range [${min}, ${max}]`);
      values.add(val);
    }
  }

  return [...values].sort((a, b) => a - b);
}

function dayMatches(year, month, day, doms, dows, domRestricted, dowRestricted) {
  const d = new Date(Date.UTC(year, month - 1, day));
  if (d.getUTCDate() !== day) return false; // non-existent date

  if (!domRestricted && !dowRestricted) return true;

  const domOk = doms.includes(day);
  const dowOk = dows.includes(d.getUTCDay());

  if (domRestricted && dowRestricted) return domOk || dowOk;
  if (domRestricted) return domOk;
  return dowOk;
}

function nextRun(cronExpr, afterMs) {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Invalid cron: expected 5 fields');

  const [minF, hrF, domF, monF, dowF] = fields;

  const minutes = parseField(minF, 0, 59);
  const hours   = parseField(hrF,  0, 23);
  const doms    = parseField(domF, 1, 31);
  const months  = parseField(monF, 1, 12);
  const dows    = parseField(dowF, 0,  6);

  const domRestricted = domF !== '*';
  const dowRestricted = dowF !== '*';

  let t = Math.floor(afterMs / 60000) * 60000 + 60000;
  const limitYear = new Date(t).getUTCFullYear() + 5;

  while (true) {
    const dt = new Date(t);
    const year = dt.getUTCFullYear();
    if (year >= limitYear) throw new Error('No match found within 5 years');

    const mo  = dt.getUTCMonth() + 1;
    const day = dt.getUTCDate();
    const hr  = dt.getUTCHours();
    const mn  = dt.getUTCMinutes();

    // Advance month if needed
    const nextMo = months.find(m => m >= mo);
    if (nextMo === undefined) {
      t = Date.UTC(year + 1, months[0] - 1, 1);
      continue;
    }
    if (nextMo > mo) {
      t = Date.UTC(year, nextMo - 1, 1);
      continue;
    }

    // Advance day if needed
    const daysInMo = new Date(Date.UTC(year, mo, 0)).getUTCDate();
    let nextDay = null;
    for (let d = day; d <= daysInMo; d++) {
      if (dayMatches(year, mo, d, doms, dows, domRestricted, dowRestricted)) {
        nextDay = d;
        break;
      }
    }
    if (nextDay === null) {
      const idx = months.findIndex(m => m > mo);
      t = idx === -1
        ? Date.UTC(year + 1, months[0] - 1, 1)
        : Date.UTC(year, months[idx] - 1, 1);
      continue;
    }
    if (nextDay > day) {
      t = Date.UTC(year, mo - 1, nextDay);
      continue;
    }

    // Advance hour if needed
    const nextHr = hours.find(h => h >= hr);
    if (nextHr === undefined) {
      t = Date.UTC(year, mo - 1, day + 1);
      continue;
    }
    if (nextHr > hr) {
      t = Date.UTC(year, mo - 1, day, nextHr);
      continue;
    }

    // Advance minute if needed
    const nextMn = minutes.find(m => m >= mn);
    if (nextMn === undefined) {
      t = Date.UTC(year, mo - 1, day, hr + 1);
      continue;
    }
    if (nextMn > mn) {
      return Date.UTC(year, mo - 1, day, hr, nextMn);
    }

    // All fields match
    return t;
  }
}

module.exports = { nextRun };
