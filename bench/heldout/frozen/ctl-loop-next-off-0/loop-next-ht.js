function nextLoopAction(state) {
  const { phase, metricImproved, attemptsLeft } = state;
  const improved = metricImproved === true;

  switch (phase) {
    case 'idle':
      return 'measure';
    case 'measured':
      return attemptsLeft > 0 ? 'attempt' : 'stop';
    case 'attempted':
      return 'judge';
    case 'judged':
      if (improved) return 'merge';
      return attemptsLeft > 0 ? 'attempt' : 'stop';
    default:
      return 'stop';
  }
}

module.exports = { nextLoopAction };
