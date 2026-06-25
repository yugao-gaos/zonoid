'use strict';

/**
 * Decide the controller's next action in the metric-driven improvement loop.
 *
 * @param {{ phase: 'idle'|'measured'|'attempted'|'judged',
 *           metricImproved: boolean|null,
 *           attemptsLeft: number }} state
 * @returns {'measure'|'attempt'|'judge'|'merge'|'stop'}
 */
function nextLoopAction(state) {
  const { phase, metricImproved, attemptsLeft } = state;
  const improved = metricImproved === true; // null treated as false

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
