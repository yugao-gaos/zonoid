const fs = require('fs');
const path = require('path');

// Orchestrator status overrides live in a single sidecar file inside the
// native task directory, so they survive across process restarts.
const OVERRIDES_FILE = '.orch-overrides.json';

function createTaskStore(dir) {
  const overridesPath = path.join(dir, OVERRIDES_FILE);

  function readOverrides() {
    try {
      return JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    } catch (err) {
      return {};
    }
  }

  function writeOverrides(overrides) {
    fs.writeFileSync(overridesPath, JSON.stringify(overrides));
  }

  function getTask(id) {
    let native;
    try {
      native = JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
    } catch (err) {
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
    writeOverrides(overrides);
  }

  return { getTask, setStatus };
}

module.exports = { createTaskStore };
