'use strict';

function parseField(field, min, max) {
  const result = new Set();

  for (const part of field.split(',')) {
    if (part.includes('/')) {
      const slashIdx = part.indexOf('/');
      const rangePart = part.slice(0, slashIdx);
      const step = parseInt(part.slice(slashIdx + 1), 10);
      if (isNaN(step) || step <= 0) throw new Error(`Invalid step in "${part}"`);

      let start, end;
      if (rangePart === '*') {
        start = min; end = max;
      } else if (rangePart.includes('-')) {
        const [s, e] = rangePart.split('-').map(Number);
        start = s; end = e;
      } else {
        start = parseInt(rangePart, 10); end = max;
      }

      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end)
        throw new Error(`Invalid range in "${part}" for [${min},${max}]`);

      for (let v = start; v <= end; v += step) result.add(v);

    } else if (part.includes('-')) {
      const [s, e] = part.split('-').map(Number);
      if (isNaN(s) || isNaN(e) || s < min || e > max || s > e)
        throw new Error(`Invalid range "${part}" for [${min},${max}]`);
      for (let v = s; v <= e; v++) result.add(v);

    } else if (part === '*') {
      for (let v = min; v <= max; v++) result.add(v);

    } else {
      const v = parseInt(part, 10);
      if (isNaN(v) || v < min || v > max)
        throw new Error(`Value ${v} out of range [${min},${max}]`);
      result.add(v);
    }
  }

  return result;
}

// Returns smallest value in set strictly greater than `after`, up to `max`. Null if none.
function findNext(set, after, max) {
  for (let v = after + 1; v <= max; v++) {
    if (set.has(v)) return v;
  }
  return null;
}

function setMin(set) {
  let m = Infinity;
  for (const v of set) if (v < m) m = v;
  return m;
}

function nextRun(cronExpr, afterMs) {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error(`Invalid cron: expected 5 fields, got ${fields.length}`);

  const [minuteField, hourField, domField, monthField, dowField] = fields;

  const minutes = parseField(minuteField, 0, 59);
  const hours   = parseField(hourField,   0, 23);
  const doms    = parseField(domField,    1, 31);
  const months  = parseField(monthField,  1, 12);
  const dows    = parseField(dowField,    0,  6);

  const domRestricted = domField !== '*';
  const dowRestricted = dowField !== '*';

  const maxYear = new Date(afterMs).getUTCFullYear() + 5;

  // Advance to start of next minute (strictly after afterMs, seconds=ms=0)
  const base = new Date(afterMs);
  let d = new Date(Date.UTC(
    base.getUTCFullYear(), base.getUTCMonth(), base.getUTCDate(),
    base.getUTCHours(), base.getUTCMinutes() + 1, 0, 0
  ));

  while (d.getUTCFullYear() <= maxYear) {
    const month = d.getUTCMonth() + 1; // 1-12

    if (!months.has(month)) {
      const nextMonth = findNext(months, month, 12);
      if (nextMonth === null) {
        d = new Date(Date.UTC(d.getUTCFullYear() + 1, setMin(months) - 1, 1, 0, 0, 0, 0));
      } else {
        d = new Date(Date.UTC(d.getUTCFullYear(), nextMonth - 1, 1, 0, 0, 0, 0));
      }
      continue;
    }

    const dom = d.getUTCDate(); // 1-31
    const dow = d.getUTCDay(); // 0-6

    let dayMatch;
    if (domRestricted && dowRestricted) {
      dayMatch = doms.has(dom) || dows.has(dow);
    } else if (domRestricted) {
      dayMatch = doms.has(dom);
    } else if (dowRestricted) {
      dayMatch = dows.has(dow);
    } else {
      dayMatch = true;
    }

    if (!dayMatch) {
      d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dom + 1, 0, 0, 0, 0));
      continue;
    }

    const hour = d.getUTCHours();

    if (!hours.has(hour)) {
      const nextHour = findNext(hours, hour, 23);
      if (nextHour === null) {
        d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dom + 1, 0, 0, 0, 0));
      } else {
        d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dom, nextHour, 0, 0, 0));
      }
      continue;
    }

    const minute = d.getUTCMinutes();

    if (!minutes.has(minute)) {
      const nextMinute = findNext(minutes, minute, 59);
      if (nextMinute === null) {
        d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dom, hour + 1, 0, 0, 0));
      } else {
        d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), dom, hour, nextMinute, 0, 0));
      }
      continue;
    }

    return d.getTime();
  }

  throw new Error('No matching time found within 5 years');
}

module.exports = { nextRun };
