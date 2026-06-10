const fs = require('fs');
const path = require('path');

// Orchestrator status overrides are kept in a sidecar file, NOT written into the
// native <id>.json files — those are owned by Claude Code (locked / may be
// overwritten), so writing them is unsafe. The sidecar lives alongside them in `dir`.
const OVERRIDES_FILE = '.orch-status-overrides.json';

function createTaskStore(dir) {
  const overridesPath = path.join(dir, OVERRIDES_FILE);

  function loadOverrides() {
    try {
      return JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    } catch (e) {
      return {};
    }
  }

  let overrides = loadOverrides();

  function getTask(id) {
    let native;
    try {
      native = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    } catch (e) {
      return null;
    }
    return {
      id: native.id,
      title: native.title,
      status: Object.prototype.hasOwnProperty.call(overrides, id)
        ? overrides[id]
        : native.status,
    };
  }

  function setStatus(id, status) {
    overrides[id] = status;
    fs.writeFileSync(overridesPath, JSON.stringify(overrides));
  }

  return { getTask, setStatus };
}

module.exports = { createTaskStore };
