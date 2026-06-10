'use strict';
// createTaskStore(dir): a store over Claude Code's native task directory.
// Native tasks live as one `<id>.json` file per task: { id, title, status }.
// The orchestrator layers its own status overrides on top, persisted durably
// in a sidecar file so a fresh store on the same dir still sees them.
const fs = require('fs');
const path = require('path');

const OVERRIDES_FILE = '.orch-overrides.json';

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
