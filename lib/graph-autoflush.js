'use strict';

const path = require('path');
const fs = require('fs');
const graphRepoDefault = require('./graph-repo');

function canonicalRepo(repoRoot) {
  const absolute = path.resolve(String(repoRoot || ''));
  try { return fs.realpathSync(absolute); } catch { return absolute; }
}

/**
 * Debounced durable graph flusher.
 *
 * State is deliberately process-local: runtime state must never become graph data. Each graph
 * repository has its own pending timer and in-flight promise, while graph-repo.serialize provides
 * the final cross-caller serialization boundary.
 */
function createGraphAutoflush(options = {}) {
  const graphRepo = options.graphRepo || graphRepoDefault;
  const delayMs = Math.max(0, Number(options.delayMs ?? process.env.ORCH_GRAPH_AUTOFLUSH_DELAY_MS) || 250);
  const retryMs = Math.max(delayMs, Number(options.retryMs ?? process.env.ORCH_GRAPH_AUTOFLUSH_RETRY_MS) || 30000);
  const entries = new Map();
  let stopped = false;

  function entryFor(repoRoot) {
    const key = canonicalRepo(repoRoot);
    let entry = entries.get(key);
    if (!entry) {
      entry = {
        repoRoot: key,
        pending: false,
        timer: null,
        running: null,
        flushes: 0,
        failures: 0,
        lastResult: null,
        lastError: null,
        lastChangeAt: null,
        lastFlushAt: null,
        changeSeq: 0,
        flushedSeq: 0,
      };
      entries.set(key, entry);
    }
    return entry;
  }

  function clearTimer(entry) {
    if (entry.timer) clearTimeout(entry.timer);
    entry.timer = null;
  }

  function scheduleEntry(entry, waitMs = delayMs) {
    if (stopped || entry.timer || entry.running) return;
    entry.timer = setTimeout(() => {
      entry.timer = null;
      flushEntry(entry).catch(() => {});
    }, Math.max(0, waitMs));
    if (entry.timer && typeof entry.timer.unref === 'function') entry.timer.unref();
  }

  async function flushEntry(entry) {
    if (stopped) return entry.lastResult;
    if (entry.running) return entry.running;
    if (!entry.pending) return entry.lastResult;

    entry.running = (async () => {
      entry.pending = false;
      const flushSeq = entry.changeSeq;
      entry.lastFlushAt = new Date().toISOString();
      let result;
      try {
        result = await graphRepo.flush(entry.repoRoot, {
          message: options.message || 'zonoid: persist graph state',
          push: true,
          ...(options.flushOptions || {}),
        });
        entry.lastResult = result;
        entry.flushedSeq = flushSeq;
        entry.lastError = result && result.error ? result.error : null;
        entry.flushes++;
        if (result && result.status === 'pending') {
          entry.pending = true;
          entry.failures++;
          scheduleEntry(entry, retryMs);
        }
        return result;
      } catch (error) {
        entry.lastError = String(error && error.message || error);
        entry.lastResult = { status: 'error', error: entry.lastError };
        entry.pending = true;
        entry.failures++;
        scheduleEntry(entry, retryMs);
        return entry.lastResult;
      } finally {
        entry.running = null;
        if (entry.pending) scheduleEntry(entry, retryMs);
        else if (entry.changeSeq > entry.flushedSeq) {
          entry.pending = true;
          scheduleEntry(entry, delayMs);
        }
      }
    })();
    return entry.running;
  }

  function notifyChange(repoRoot) {
    if (!repoRoot || stopped) return false;
    const entry = entryFor(repoRoot);
    entry.pending = true;
    entry.changeSeq++;
    entry.lastChangeAt = new Date().toISOString();
    clearTimer(entry);
    scheduleEntry(entry, delayMs);
    return true;
  }

  function flushNow(repoRoot) {
    if (!repoRoot || stopped) return Promise.resolve(null);
    const entry = entryFor(repoRoot);
    entry.pending = true;
    clearTimer(entry);
    return flushEntry(entry);
  }

  function stop() {
    stopped = true;
    for (const entry of entries.values()) clearTimer(entry);
  }

  function status(repoRoot) {
    if (repoRoot) {
      const entry = entries.get(canonicalRepo(repoRoot));
      if (!entry) return { repoRoot: canonicalRepo(repoRoot), pending: false, running: false, stopped };
      return { ...entry, running: !!entry.running, timer: !!entry.timer };
    }
    return {
      stopped,
      repos: Array.from(entries.values(), (entry) => ({ ...entry, running: !!entry.running, timer: !!entry.timer })),
    };
  }

  return { notifyChange, schedule: notifyChange, flushNow, stop, status };
}

module.exports = { createGraphAutoflush, canonicalRepo };
