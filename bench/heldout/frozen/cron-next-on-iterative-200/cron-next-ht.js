'use strict';

function expandField(field, min, max) {
  const result = new Set();
  for (const part of field.split(',')) {
    if (part === '*') {
      for (let i = min; i <= max; i++) result.add(i);
    } else if (part.includes('/')) {
      const si = part.indexOf('/');
      const range = part.slice(0, si);
      const step = parseInt(part.slice(si + 1), 10);
      if (isNaN(step) || step < 1) throw new Error(`Invalid step in cron field: "${part}"`);
      let lo, hi;
      if (range === '*') {
        lo = min; hi = max;
      } else if (range.includes('-')) {
        const di = range.indexOf('-');
        lo = parseInt(range.slice(0, di), 10);
        hi = parseInt(range.slice(di + 1), 10);
        if (isNaN(lo) || isNaN(hi)) throw new Error(`Invalid range in cron field: "${part}"`);
      } else {
        lo = parseInt(range, 10);
        hi = max;
        if (isNaN(lo)) throw new Error(`Invalid value in cron field: "${part}"`);
      }
      for (let i = lo; i <= hi; i += step) result.add(i);
    } else if (part.includes('-')) {
      const di = part.indexOf('-');
      const lo = parseInt(part.slice(0, di), 10);
      const hi = parseInt(part.slice(di + 1), 10);
      if (isNaN(lo) || isNaN(hi)) throw new Error(`Invalid range in cron field: "${part}"`);
      for (let i = lo; i <= hi; i++) result.add(i);
    } else {
      const v = parseInt(part, 10);
      if (isNaN(v)) throw new Error(`Invalid value in cron field: "${part}"`);
      result.add(v);
    }
  }
  for (const v of result) {
    if (v < min || v > max) throw new Error(`Value ${v} out of range [${min}, ${max}]`);
  }
  return result;
}

function nextRun(cronExpr, afterMs) {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron: expected 5 fields, got ${fields.length}`);

  const [minF, hourF, domF, monF, dowF] = fields;

  const minuteSet = expandField(minF, 0, 59);
  const hourSet   = expandField(hourF, 0, 23);
  const domSet    = expandField(domF, 1, 31);
  const monthSet  = expandField(monF, 1, 12);
  const dowSet    = expandField(dowF, 0, 6);

  const domRestricted = domF !== '*';
  const dowRestricted = dowF !== '*';

  const sortedMinutes = [...minuteSet].sort((a, b) => a - b);
  const sortedHours   = [...hourSet].sort((a, b) => a - b);

  // First candidate: next whole minute strictly after afterMs
  let t = (Math.floor(afterMs / 60000) + 1) * 60000;
  const deadline = Date.UTC(new Date(t).getUTCFullYear() + 5, 0, 1);

  while (t < deadline) {
    const d     = new Date(t);
    const year  = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1; // 1-12

    if (!monthSet.has(month)) {
      // Jump to 1st of the next matching month
      let y = year, m = month + 1;
      if (m > 12) { m = 1; y++; }
      while (!monthSet.has(m)) {
        m++;
        if (m > 12) { m = 1; y++; }
      }
      t = Date.UTC(y, m - 1, 1, 0, 0, 0);
      continue;
    }

    const dom = d.getUTCDate();
    const dow = d.getUTCDay();

    let dayOk;
    if (domRestricted && dowRestricted) {
      dayOk = domSet.has(dom) || dowSet.has(dow);
    } else if (domRestricted) {
      dayOk = domSet.has(dom);
    } else if (dowRestricted) {
      dayOk = dowSet.has(dow);
    } else {
      dayOk = true;
    }

    if (!dayOk) {
      // Date.UTC handles month/year overflow naturally
      t = Date.UTC(year, month - 1, dom + 1, 0, 0, 0);
      continue;
    }

    const hour = d.getUTCHours();
    if (!hourSet.has(hour)) {
      const nextHour = sortedHours.find(h => h > hour);
      t = nextHour !== undefined
        ? Date.UTC(year, month - 1, dom, nextHour, 0, 0)
        : Date.UTC(year, month - 1, dom + 1, 0, 0, 0);
      continue;
    }

    const minute = d.getUTCMinutes();
    if (!minuteSet.has(minute)) {
      const nextMin = sortedMinutes.find(m => m > minute);
      t = nextMin !== undefined
        ? Date.UTC(year, month - 1, dom, hour, nextMin, 0)
        : Date.UTC(year, month - 1, dom, hour + 1, 0, 0);
      continue;
    }

    return t;
  }

  throw new Error('No cron match found within 5 years');
}

module.exports = { nextRun };
