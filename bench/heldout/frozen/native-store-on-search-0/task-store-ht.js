'use strict';

const fs = require('fs');
const path = require('path');

function createTaskStore(dir) {
  const overridesPath = path.join(dir, '.task-store-overrides.json');

  function loadOverrides() {
    try {
      return JSON.parse(fs.readFileSync(overridesPath, 'utf8'));
    } catch {
      return {};
    }
  }

  function saveOverrides(overrides) {
    fs.writeFileSync(overridesPath, JSON.stringify(overrides), 'utf8');
  }

  return {
    getTask(id) {
      const filePath = path.join(dir, `${id}.json`);
      let native;
      try {
        native = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      } catch {
        return null;
      }
      const overrides = loadOverrides();
      return {
        id: native.id,
        title: native.title,
        status: id in overrides ? overrides[id] : native.status,
      };
    },

    setStatus(id, status) {
      const overrides = loadOverrides();
      overrides[id] = status;
      saveOverrides(overrides);
    },
  };
}

module.exports = { createTaskStore };
