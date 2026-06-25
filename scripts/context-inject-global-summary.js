'use strict';

const http = require('http');
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const CACHE_PATH = '/tmp/context-inject-summary-cache.json';
const CACHE_TTL_MS = 60 * 1000;
const GRAPH_URL = 'http://localhost:8787/api/graph?scope=frontier&compact=true';
const CLAUDE_BIN = '/opt/homebrew/bin/claude';

function fetchJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let data = '';
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error(`JSON parse error: ${e.message}`)); }
      });
    }).on('error', reject);
  });
}

function readCache() {
  try {
    const raw = fs.readFileSync(CACHE_PATH, 'utf8');
    const cached = JSON.parse(raw);
    if (Date.now() - cached.ts < CACHE_TTL_MS) {
      return cached.summary;
    }
  } catch (_) {}
  return null;
}

function writeCache(summary) {
  fs.writeFileSync(CACHE_PATH, JSON.stringify({ ts: Date.now(), summary }));
}

function extractGraphData(graph) {
  // Count tasks by status
  const statusCounts = {};
  const readyTasks = [];
  const doneTasks = [];

  const nodes = graph.nodes || graph.tasks || [];
  for (const node of nodes) {
    const status = node.status || 'unknown';
    statusCounts[status] = (statusCounts[status] || 0) + 1;

    if (status === 'ready') {
      readyTasks.push(node.title || node.key || '(untitled)');
    }
    if (status === 'done') {
      doneTasks.push({
        title: node.title || node.key || '(untitled)',
        summary: node.summary || node.completion_summary || '',
        completedAt: node.completed_at || node.updated_at || 0,
      });
    }
  }

  // Top 3 ready tasks (first 3 from list)
  const topReady = readyTasks.slice(0, 3);

  // Top 3 recent done tasks (sorted by completion time, descending)
  doneTasks.sort((a, b) => (b.completedAt > a.completedAt ? 1 : -1));
  const topDone = doneTasks.slice(0, 3);

  return { statusCounts, topReady, topDone };
}

function buildPrompt({ statusCounts, topReady, topDone }) {
  const statusLine = Object.entries(statusCounts)
    .map(([s, n]) => `${s}: ${n}`)
    .join(', ');

  const readyLine = topReady.length
    ? topReady.map((t) => `"${t}"`).join(', ')
    : 'none';

  const doneLine = topDone.length
    ? topDone.map((t) => `"${t.title}"${t.summary ? ` (${t.summary.slice(0, 80)})` : ''}`).join('; ')
    : 'none';

  return `You are a concise status reporter for a software task graph. Based on the data below, write a single compact paragraph (≤120 words) summarizing the current state of the graph. Be specific about what's in progress and what's ready next. No bullet points, no headers.

Task counts by status: ${statusLine}
Top ready tasks: ${readyLine}
Recent completed tasks: ${doneLine}

Write only the paragraph, nothing else.`;
}

function callClaude(prompt) {
  const result = execFileSync(
    CLAUDE_BIN,
    ['-p', '--model', 'claude-haiku-4-5-20251001'],
    {
      input: prompt,
      encoding: 'utf8',
      timeout: 30000,
      windowsHide: true,
    }
  );
  return result.trim();
}

async function getGlobalSummary() {
  const cached = readCache();
  if (cached) return { summary: cached, cacheHit: true };

  const graph = await fetchJson(GRAPH_URL);
  const extracted = extractGraphData(graph);
  const prompt = buildPrompt(extracted);
  const summary = callClaude(prompt);

  writeCache(summary);
  return { summary, cacheHit: false };
}

module.exports = { getGlobalSummary };

if (require.main === module) {
  const isTest = process.argv.includes('--test');

  getGlobalSummary()
    .then(({ summary, cacheHit }) => {
      console.log(summary);
      if (isTest) {
        console.log(`\n[cache hit: ${cacheHit}]`);
      }
    })
    .catch((err) => {
      console.error('Error:', err.message);
      process.exit(1);
    });
}
