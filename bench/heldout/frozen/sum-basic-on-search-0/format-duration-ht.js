function formatDuration(ms) {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;

  const parts = [];
  if (hours) parts.push(hours + 'h');
  if (minutes) parts.push(minutes + 'm');
  if (seconds) parts.push(seconds + 's');

  return parts.length ? parts.join(' ') : '0s';
}

module.exports = { formatDuration };
