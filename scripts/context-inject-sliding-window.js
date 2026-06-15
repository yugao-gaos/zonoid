'use strict';

const http = require('http');

/**
 * Fetch the frontier graph state and return the k most recently completed tasks.
 * @param {number} k - number of tasks to return (default 5)
 * @returns {Promise<Array<{task_key: string, title: string, summary: string}>>}
 */
function getWindowContext(k = 5) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      'http://localhost:8787/state?scope=frontier&compact=true',
      (res) => {
        let data = '';
        res.on('data', (chunk) => { data += chunk; });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            return reject(new Error(`HTTP ${res.statusCode}: ${data}`));
          }
          let graph;
          try {
            graph = JSON.parse(data);
          } catch (e) {
            return reject(new Error(`Failed to parse graph response: ${e.message}`));
          }

          // Support both array and { tasks: [...] } response shapes
          const nodes = Array.isArray(graph) ? graph : (graph.tasks || []);

          const window = nodes
            .filter((n) => n.status === 'done')
            .sort((a, b) => {
              const ta = new Date(a.lastChanged || a.last_changed || 0).getTime();
              const tb = new Date(b.lastChanged || b.last_changed || 0).getTime();
              return tb - ta;
            })
            .slice(0, k)
            .map((n) => ({
              task_key: n.task_key || n.key || n.id || '',
              title: n.title || n.label || '',
              summary: n.summary || '',
            }));

          resolve(window);
        });
      }
    );
    req.on('error', reject);
  });
}

module.exports = { getWindowContext };

if (require.main === module) {
  const hasTest = process.argv.includes('--test');
  if (hasTest) {
    getWindowContext(5)
      .then((results) => {
        console.log(JSON.stringify(results, null, 2));
      })
      .catch((err) => {
        console.error('Error:', err.message);
        process.exit(1);
      });
  } else {
    console.log('Usage: node context-inject-sliding-window.js --test');
  }
}
