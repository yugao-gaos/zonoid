function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];
  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const result = [sorted[0].slice()];
  for (let i = 1; i < sorted.length; i++) {
    const current = sorted[i];
    const last = result[result.length - 1];
    if (current[0] <= last[1]) {
      if (current[1] > last[1]) last[1] = current[1];
    } else {
      result.push(current.slice());
    }
  }
  return result;
}

module.exports = { mergeIntervals };
