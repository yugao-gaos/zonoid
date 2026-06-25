function nextRun(cronExpr, afterMs) {
  const fields = cronExpr.split(' ');
  if (fields.length !== 5) throw new Error('Invalid cron expression: expected 5 fields');

  const [minF, hrF, domF, monF, dowF] = fields;

  function parseField(field, min, max) {
    if (field === '*') return null; // null means "any"

    const values = new Set();
    for (const part of field.split(',')) {
      if (part === '*') {
        for (let i = min; i <= max; i++) values.add(i);
      } else if (part.startsWith('*/')) {
        const step = parseInt(part.slice(2), 10);
        if (isNaN(step) || step <= 0) throw new Error(`Invalid step in field: ${part}`);
        for (let i = min; i <= max; i += step) values.add(i);
      } else if (part.includes('/')) {
        const [range, stepStr] = part.split('/');
        const step = parseInt(stepStr, 10);
        if (isNaN(step) || step <= 0) throw new Error(`Invalid step in field: ${part}`);
        const [startStr, endStr] = range.split('-');
        const start = parseInt(startStr, 10);
        const end = endStr !== undefined ? parseInt(endStr, 10) : max;
        if (isNaN(start) || isNaN(end)) throw new Error(`Invalid range in field: ${part}`);
        if (start < min || end > max) throw new Error(`Value out of range in field: ${part}`);
        for (let i = start; i <= end; i += step) values.add(i);
      } else if (part.includes('-')) {
        const [startStr, endStr] = part.split('-');
        const start = parseInt(startStr, 10);
        const end = parseInt(endStr, 10);
        if (isNaN(start) || isNaN(end)) throw new Error(`Invalid range in field: ${part}`);
        if (start < min || end > max) throw new Error(`Value out of range in field: ${part}`);
        for (let i = start; i <= end; i++) values.add(i);
      } else {
        const val = parseInt(part, 10);
        if (isNaN(val)) throw new Error(`Invalid value in field: ${part}`);
        if (val < min || val > max) throw new Error(`Value ${val} out of range [${min},${max}]`);
        values.add(val);
      }
    }
    return values;
  }

  const minutes = parseField(minF, 0, 59);
  const hours = parseField(hrF, 0, 23);
  const doms = parseField(domF, 1, 31);
  const months = parseField(monF, 1, 12);
  const dows = parseField(dowF, 0, 6);

  const domRestricted = doms !== null;
  const dowRestricted = dows !== null;

  function matchesDay(year, month, day) {
    // Validate date exists
    const d = new Date(Date.UTC(year, month - 1, day));
    if (d.getUTCFullYear() !== year || d.getUTCMonth() !== month - 1 || d.getUTCDate() !== day) {
      return false;
    }
    const dow = d.getUTCDay(); // 0=Sunday

    if (domRestricted && dowRestricted) {
      return doms.has(day) || dows.has(dow);
    } else if (domRestricted) {
      return doms.has(day);
    } else if (dowRestricted) {
      return dows.has(dow);
    }
    return true;
  }

  function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
  }

  // Start from afterMs + 1 minute (truncate to minute boundary, then +1 min)
  const startMs = afterMs + 1;
  const startDate = new Date(startMs);
  let year = startDate.getUTCFullYear();
  let month = startDate.getUTCMonth() + 1;
  let day = startDate.getUTCDate();
  let hour = startDate.getUTCHours();
  let minute = startDate.getUTCMinutes();

  // Advance to next minute if there are remaining seconds/ms
  const seconds = startDate.getUTCSeconds();
  const ms = startDate.getUTCMilliseconds();
  if (seconds > 0 || ms > 0) {
    minute++;
    if (minute >= 60) { minute = 0; hour++; }
    if (hour >= 24) { hour = 0; day++; }
    // day overflow handled below
  }

  const maxYear = year + 5;

  outer:
  while (year <= maxYear) {
    // Check month
    if (months !== null && !months.has(month)) {
      month++;
      if (month > 12) { month = 1; year++; }
      day = 1; hour = 0; minute = 0;
      continue;
    }

    const dim = daysInMonth(year, month);

    // Check day overflow from previous increment
    if (day > dim) {
      month++;
      if (month > 12) { month = 1; year++; }
      day = 1; hour = 0; minute = 0;
      continue;
    }

    // Check day
    if (!matchesDay(year, month, day)) {
      day++;
      if (day > dim) { month++; if (month > 12) { month = 1; year++; } day = 1; }
      hour = 0; minute = 0;
      continue;
    }

    // Check hour
    if (hours !== null && !hours.has(hour)) {
      hour++;
      if (hour >= 24) { hour = 0; day++; if (day > dim) { month++; if (month > 12) { month = 1; year++; } day = 1; } }
      minute = 0;
      continue;
    }

    // Check minute
    if (minutes !== null && !minutes.has(minute)) {
      minute++;
      if (minute >= 60) {
        minute = 0; hour++;
        if (hour >= 24) {
          hour = 0; day++;
          if (day > dim) { month++; if (month > 12) { month = 1; year++; } day = 1; }
        }
      }
      continue;
    }

    // All fields match — but we need to verify this is strictly after afterMs
    const candidate = Date.UTC(year, month - 1, day, hour, minute, 0, 0);
    if (candidate > afterMs) {
      return candidate;
    }
    // Shouldn't happen given our start logic, but advance by 1 minute just in case
    minute++;
    if (minute >= 60) {
      minute = 0; hour++;
      if (hour >= 24) {
        hour = 0; day++;
        if (day > daysInMonth(year, month)) { month++; if (month > 12) { month = 1; year++; } day = 1; }
      }
    }
  }

  throw new Error('No matching time found within 5 years');
}

module.exports = { nextRun };
