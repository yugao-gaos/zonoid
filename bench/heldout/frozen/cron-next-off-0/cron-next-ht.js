function parseField(expr, min, max) {
  const values = new Set();

  for (const part of expr.split(',')) {
    if (!part) throw new Error(`Invalid cron field: empty element in '${expr}'`);

    if (part === '*') {
      for (let i = min; i <= max; i++) values.add(i);
      continue;
    }

    const slashIdx = part.indexOf('/');

    if (slashIdx !== -1) {
      const step = Number(part.slice(slashIdx + 1));
      if (!Number.isInteger(step) || step <= 0) {
        throw new Error(`Invalid cron step: '${part}'`);
      }

      const rangePart = part.slice(0, slashIdx);
      let start, end;

      if (rangePart === '*') {
        start = min;
        end = max;
      } else {
        const dashIdx = rangePart.indexOf('-');
        if (dashIdx !== -1) {
          start = Number(rangePart.slice(0, dashIdx));
          end = Number(rangePart.slice(dashIdx + 1));
          if (!Number.isInteger(start) || !Number.isInteger(end) ||
              start < min || end > max || start > end) {
            throw new Error(`Invalid cron range: '${part}' (field range ${min}-${max})`);
          }
        } else {
          start = Number(rangePart);
          if (!Number.isInteger(start) || start < min || start > max) {
            throw new Error(`Invalid cron value: '${part}' (field range ${min}-${max})`);
          }
          end = max;
        }
      }

      for (let i = start; i <= end; i += step) values.add(i);
    } else if (part.includes('-')) {
      const dashIdx = part.indexOf('-');
      const start = Number(part.slice(0, dashIdx));
      const end = Number(part.slice(dashIdx + 1));
      if (!Number.isInteger(start) || !Number.isInteger(end) ||
          start < min || end > max || start > end) {
        throw new Error(`Invalid cron range: '${part}' (field range ${min}-${max})`);
      }
      for (let i = start; i <= end; i++) values.add(i);
    } else {
      const val = Number(part);
      if (!Number.isInteger(val) || val < min || val > max) {
        throw new Error(`Invalid cron value: '${part}' (expected ${min}-${max})`);
      }
      values.add(val);
    }
  }

  return [...values].sort((a, b) => a - b);
}

function nextRun(cronExpr, afterMs) {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) {
    throw new Error(`Invalid cron expression: expected 5 fields, got ${fields.length}`);
  }

  const [minuteExpr, hourExpr, domExpr, monthExpr, dowExpr] = fields;

  const minArr = parseField(minuteExpr, 0, 59);
  const hrArr  = parseField(hourExpr, 0, 23);
  const domArr = parseField(domExpr, 1, 31);
  const monArr = parseField(monthExpr, 1, 12);
  const dowArr = parseField(dowExpr, 0, 6);

  const domRestricted = domExpr !== '*';
  const dowRestricted = dowExpr !== '*';

  const minSet = new Set(minArr);
  const hrSet  = new Set(hrArr);
  const domSet = new Set(domArr);
  const monSet = new Set(monArr);
  const dowSet = new Set(dowArr);

  function dayMatches(dom, dow) {
    if (domRestricted && dowRestricted) return domSet.has(dom) || dowSet.has(dow);
    if (domRestricted) return domSet.has(dom);
    if (dowRestricted) return dowSet.has(dow);
    return true;
  }

  // First full minute strictly after afterMs
  let t = Math.floor(afterMs / 60000) * 60000 + 60000;
  const limit = afterMs + 5 * 366 * 24 * 60 * 60 * 1000;

  while (t <= limit) {
    const d = new Date(t);
    const year  = d.getUTCFullYear();
    const month = d.getUTCMonth() + 1;
    const dom   = d.getUTCDate();
    const dow   = d.getUTCDay();
    const hour  = d.getUTCHours();
    const min   = d.getUTCMinutes();

    if (!monSet.has(month)) {
      const next = monArr.find(m => m > month);
      t = next !== undefined
        ? Date.UTC(year, next - 1, 1, 0, 0, 0, 0)
        : Date.UTC(year + 1, monArr[0] - 1, 1, 0, 0, 0, 0);
      continue;
    }

    if (!dayMatches(dom, dow)) {
      t = Date.UTC(year, month - 1, dom + 1, 0, 0, 0, 0);
      continue;
    }

    if (!hrSet.has(hour)) {
      const next = hrArr.find(h => h > hour);
      t = next !== undefined
        ? Date.UTC(year, month - 1, dom, next, minArr[0], 0, 0)
        : Date.UTC(year, month - 1, dom + 1, 0, 0, 0, 0);
      continue;
    }

    if (!minSet.has(min)) {
      const nextMin = minArr.find(m => m > min);
      if (nextMin !== undefined) {
        t = Date.UTC(year, month - 1, dom, hour, nextMin, 0, 0);
      } else {
        const nextHr = hrArr.find(h => h > hour);
        t = nextHr !== undefined
          ? Date.UTC(year, month - 1, dom, nextHr, minArr[0], 0, 0)
          : Date.UTC(year, month - 1, dom + 1, 0, 0, 0, 0);
      }
      continue;
    }

    return t;
  }

  throw new Error('No cron match found within 5 years');
}

module.exports = { nextRun };
