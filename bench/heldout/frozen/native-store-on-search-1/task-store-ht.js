const fs = require('fs');
const path = require('path');

// Orchestrator status overrides are kept in a sidecar file, never folded back
// into the native <id>.json files: those are owned by Claude Code (lock file,
// may be overwritten), so writing them is unsafe.
const OVERRIDES_FILE = '.orch-status.json';

function createTaskStore(dir) {
  const overridesPath = path.join(dir, OVERRIDES_FILE);

  function readOverrides() {
    try {
      return JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    } catch {
      return {};
    }
  }

  function getTask(id) {
    let native;
    try {
      native = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    } catch {
      return null;
    }
    const overrides = readOverrides();
    const status = Object.prototype.hasOwnProperty.call(overrides, id)
      ? overrides[id]
      : native.status;
    return { id, title: native.title, status };
  }

  function setStatus(id, status) {
    const overrides = readOverrides();
    overrides[id] = status;
    fs.writeFileSync(overridesPath, JSON.stringify(overrides));
  }

  return { getTask, setStatus };
}

module.exports = { createTaskStore };
