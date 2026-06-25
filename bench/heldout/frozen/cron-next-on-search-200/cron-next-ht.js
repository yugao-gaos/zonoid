function nextRun(cronExpr, afterMs) {
  const fields = cronExpr.trim().split(/\s+/);
  if (fields.length !== 5) throw new Error('Invalid cron expression: must have 5 fields');

  const [minuteField, hourField, domField, monthField, dowField] = fields;

  const parseField = (field, min, max) => {
    const values = new Set();
    for (const part of field.split(',')) {
      let step = 1, main = part;
      if (part.includes('/')) {
        const si = part.indexOf('/');
        main = part.slice(0, si);
        step = parseInt(part.slice(si + 1), 10);
        if (isNaN(step) || step <= 0) throw new Error('Invalid cron expression');
      }
      let start, end;
      if (main === '*') {
        start = min; end = max;
      } else if (main.includes('-')) {
        const di = main.indexOf('-');
        start = parseInt(main.slice(0, di), 10);
        end = parseInt(main.slice(di + 1), 10);
      } else {
        start = parseInt(main, 10);
        end = part.includes('/') ? max : start;
      }
      if (isNaN(start) || isNaN(end) || start < min || end > max || start > end)
        throw new Error('Invalid cron expression');
      for (let i = start; i <= end; i += step) values.add(i);
    }
    return [...values].sort((a, b) => a - b);
  };

  const minutes   = parseField(minuteField, 0, 59);
  const hours     = parseField(hourField,   0, 23);
  const domList   = parseField(domField,    1, 31);
  const monthList = parseField(monthField,  1, 12);
  const dowList   = parseField(dowField,    0,  6);
  const minuteSet = new Set(minutes);
  const hourSet   = new Set(hours);
  const domSet    = new Set(domList);
  const monthSet  = new Set(monthList);
  const dowSet    = new Set(dowList);
  const domRestricted = domField !== '*';
  const dowRestricted = dowField !== '*';

  let t = (Math.floor(afterMs / 60000) + 1) * 60000;
  const maxT = afterMs + 5 * 365.25 * 24 * 3600 * 1000;

  while (t <= maxT) {
    const d = new Date(t);
    const year = d.getUTCFullYear(), month = d.getUTCMonth() + 1;
    const dom  = d.getUTCDate(),    hour  = d.getUTCHours();
    const minute = d.getUTCMinutes(), dow = d.getUTCDay();

    if (!monthSet.has(month)) {
      const nm = monthList.find(m => m > month);
      t = nm != null ? Date.UTC(year, nm - 1, 1, 0, 0, 0, 0)
                     : Date.UTC(year + 1, monthList[0] - 1, 1, 0, 0, 0, 0);
      continue;
    }

    const domMatch = domSet.has(dom), dowMatch = dowSet.has(dow);
    const dayMatch = (domRestricted && dowRestricted) ? (domMatch || dowMatch)
                   : domRestricted ? domMatch : dowRestricted ? dowMatch : true;

    if (!dayMatch) {
      t = Date.UTC(year, month - 1, dom + 1, 0, 0, 0, 0);
      continue;
    }

    if (!hourSet.has(hour)) {
      const nh = hours.find(h => h > hour);
      t = nh != null ? Date.UTC(year, month - 1, dom, nh, 0, 0, 0)
                     : Date.UTC(year, month - 1, dom + 1, 0, 0, 0, 0);
      continue;
    }

    if (!minuteSet.has(minute)) {
      const nm = minutes.find(m => m > minute);
      if (nm != null) {
        t = Date.UTC(year, month - 1, dom, hour, nm, 0, 0);
      } else {
        const nh = hours.find(h => h > hour);
        t = nh != null ? Date.UTC(year, month - 1, dom, nh, 0, 0, 0)
                       : Date.UTC(year, month - 1, dom + 1, 0, 0, 0, 0);
      }
      continue;
    }

    return t;
  }

  throw new Error('No matching time found within 5 years');
}

module.exports = { nextRun };
