const fs = require('fs');
const path = require('path');

// Single sidecar file holding all orchestrator status overrides for `dir`,
// keyed by task id. Kept out of the native task list (dotfile, not `<id>.json`)
// so it never looks like a task.
const OVERRIDES_FILE = '.orch-overrides.json';

function readOverrides(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, OVERRIDES_FILE), 'utf8'));
  } catch {
    return {};
  }
}

function writeOverrides(dir, overrides) {
  fs.writeFileSync(
    path.join(dir, OVERRIDES_FILE),
    JSON.stringify(overrides, null, 2)
  );
}

function readNative(dir, id) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, `${id}.json`), 'utf8'));
  } catch {
    return null;
  }
}

function createTaskStore(dir) {
  return {
    getTask(id) {
      const native = readNative(dir, id);
      if (native === null) return null;
      // Re-read overrides each call so a store sees writes from other instances.
      const overrides = readOverrides(dir);
      const status = Object.prototype.hasOwnProperty.call(overrides, id)
        ? overrides[id]
        : native.status;
      return { id: native.id, title: native.title, status };
    },

    setStatus(id, status) {
      const overrides = readOverrides(dir);
      overrides[id] = status;
      writeOverrides(dir, overrides);
    },
  };
}

module.exports = { createTaskStore };
