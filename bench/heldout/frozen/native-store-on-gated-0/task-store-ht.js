'use strict';

const fs = require('fs');
const path = require('path');

function createTaskStore(dir) {
  const overridesPath = path.join(dir, '_orch_overrides.json');

  function readOverrides() {
    try {
      return JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    } catch {
      return {};
    }
  }

  function writeOverrides(overrides) {
    fs.writeFileSync(overridesPath, JSON.stringify(overrides), 'utf8');
  }

  return {
    getTask(id) {
      const taskPath = path.join(dir, `${id}.json`);
      let native;
      try {
        native = JSON.parse(fs.readFileSync(taskPath, 'utf8'));
      } catch {
        return null;
      }
      const overrides = readOverrides();
      return {
        id: native.id,
        title: native.title,
        status: overrides[id] !== undefined ? overrides[id] : native.status,
      };
    },

    setStatus(id, status) {
      const overrides = readOverrides();
      overrides[id] = status;
      writeOverrides(overrides);
    },
  };
}

module.exports = { createTaskStore };
