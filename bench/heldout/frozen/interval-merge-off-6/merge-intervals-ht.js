function mergeIntervals(intervals) {
  if (intervals.length <= 1) return intervals.slice();

  const sorted = intervals.slice().sort((a, b) => a[0] - b[0]);
  const result = [sorted[0].slice()];

  for (let i = 1; i < sorted.length; i++) {
    const last = result[result.length - 1];
    const curr = sorted[i];
    if (curr[0] <= last[1]) {
      last[1] = Math.max(last[1], curr[1]);
    } else {
      result.push(curr.slice());
    }
  }

  return result;
}

module.exports = { mergeIntervals };
