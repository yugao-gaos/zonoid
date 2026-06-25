function mergeIntervals(intervals) {
  if (intervals.length === 0) return [];

  const sorted = [...intervals].sort((a, b) => a[0] - b[0]);
  const result = [sorted[0].slice()];

  for (let i = 1; i < sorted.length; i++) {
    const current = result[result.length - 1];
    const next = sorted[i];
    if (next[0] <= current[1]) {
      current[1] = Math.max(current[1], next[1]);
    } else {
      result.push(next.slice());
    }
  }

  return result;
}

module.exports = { mergeIntervals };
