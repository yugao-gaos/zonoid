'use strict';

function nextLoopAction({ phase, metricImproved, attemptsLeft }) {
  switch (phase) {
    case 'idle':
      return 'measure';
    case 'measured':
      return attemptsLeft > 0 ? 'attempt' : 'stop';
    case 'attempted':
      return 'judge';
    case 'judged':
      if (metricImproved === true) return 'merge';
      return attemptsLeft > 0 ? 'attempt' : 'stop';
    default:
      return 'stop';
  }
}

module.exports = { nextLoopAction };
