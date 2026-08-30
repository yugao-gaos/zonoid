'use strict';
const fs = require('fs');
const path = require('path');
const filedrop = require('../filedrop-tasks');

const TERMINAL_STATUSES = new Set(['done', 'completed', 'tested', 'failed', 'canceled']);

function createFiledropNamespaceTasks(namespace) {
  let boundWorkspace = null;

  function workspaceFor(explicit) {
    const value = explicit || process.env.ORCH_WORKSPACE || boundWorkspace;
    if (!value) return null;
    boundWorkspace = path.resolve(String(value));
    return boundWorkspace;
  }

  function owns(key) {
    const split = filedrop.splitKey(key);
    return !!(split && split.harness === namespace);
  }

  function aggregateWorkspace(workspace, snapshots = {}) {
    const ws = workspaceFor(workspace);
    if (!ws) return [];
    const live = filedrop.aggregateWorkspace(ws).filter((task) => task.session === namespace);
    const seen = new Set(live.map((task) => task.key));
    const tasks = live.map((task) => {
      const snapshot = snapshots[task.key];
      if (!snapshot) return task;
      return {
        ...task,
        label: snapshot.subject || task.label,
        description: snapshot.description || '',
        native_status: TERMINAL_STATUSES.has(String(snapshot.status))
          ? snapshot.status
          : task.native_status,
        deps: filedrop.normalizeDeps(namespace, snapshot.blockedBy),
      };
    });
    for (const [key, snapshot] of Object.entries(snapshots)) {
      if (!owns(key) || seen.has(key)) continue;
      const split = filedrop.splitKey(key);
      tasks.push({
        key,
        session: namespace,
        id: split.id,
        label: snapshot.subject || split.id,
        description: snapshot.description || '',
        native_status: snapshot.status || 'completed',
        deps: filedrop.normalizeDeps(namespace, snapshot.blockedBy),
      });
    }
    return tasks;
  }

  function readTask(namespacedKey, workspace) {
    const ws = workspaceFor(workspace);
    if (!ws || !owns(namespacedKey)) return null;
    return filedrop.readTask(ws, namespacedKey);
  }

  function readSessionTasksRaw(sessionId, workspace) {
    const ws = workspaceFor(workspace);
    if (!ws || String(sessionId) !== namespace) return [];
    return filedrop.aggregateWorkspace(ws)
      .filter((task) => task.session === namespace)
      .map((task) => filedrop.readTask(ws, task.key))
      .filter(Boolean);
  }

  function writeStatus(namespacedKey, status, workspace) {
    const ws = workspaceFor(workspace);
    return !!(ws && owns(namespacedKey) && filedrop.writeStatus(ws, namespacedKey, status));
  }

  function formatHealth(workspace) {
    const ws = workspaceFor(workspace);
    if (!ws) {
      return { sessions: 0, files: 0, parsed: 0, wellFormed: 0, anomalies: [], healthy: true };
    }
    const dir = path.join(filedrop.dirFor(ws), namespace);
    let entries;
    try { entries = fs.readdirSync(dir).filter((name) => name.endsWith('.json')); }
    catch { return { sessions: 0, files: 0, parsed: 0, wellFormed: 0, anomalies: [], healthy: true }; }

    let parsed = 0;
    let wellFormed = 0;
    const anomalies = [];
    for (const name of entries) {
      let task;
      try { task = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8')); }
      catch {
        if (anomalies.length < 5) anomalies.push(`${namespace}/${name}: unparseable`);
        continue;
      }
      parsed++;
      const expectedId = name.slice(0, -'.json'.length);
      const valid = task && task.id != null && String(task.id) === expectedId && !!task.subject
        && (task.status == null || typeof task.status === 'string')
        && (task.blockedBy == null || Array.isArray(task.blockedBy));
      if (valid) wellFormed++;
      else if (anomalies.length < 5) anomalies.push(`${namespace}/${name}: invalid v1 stub`);
    }
    const files = entries.length;
    return {
      sessions: files ? 1 : 0,
      files,
      parsed,
      wellFormed,
      anomalies,
      healthy: files === 0 || wellFormed / files >= 0.8,
    };
  }

  return {
    aggregateWorkspace,
    readTask,
    readSessionTasksRaw,
    writeStatus,
    watch(onChange) { return filedrop.watch(onChange); },
    formatHealth,
  };
}

module.exports = { createFiledropNamespaceTasks };
