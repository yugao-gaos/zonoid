'use strict';

const path = require('path');
const { RUNTIME_DIRNAME } = require('./runtime-paths');

function workspaceName(workspaceRoot) {
  const clean = String(workspaceRoot || '').replace(/[\\/]+$/, '');
  const parts = clean.split(/[\\/]/).filter(Boolean);
  return parts[parts.length - 1] || 'workspace';
}

function workspaceRoot(workspaceRootArg) {
  return path.resolve(workspaceRootArg || process.cwd());
}

function onboardRuntimeRoot(workspaceRootArg) {
  return path.join(workspaceRoot(workspaceRootArg), RUNTIME_DIRNAME, 'onboard');
}

function defaultOnboardOutDir(workspaceRootArg) {
  const root = workspaceRoot(workspaceRootArg);
  return path.join(root, RUNTIME_DIRNAME, 'onboard', workspaceName(root));
}

function legacyGraphOnboardOutDir(workspaceRootArg) {
  return path.join(workspaceRoot(workspaceRootArg), '.graph', 'onboard');
}

function legacyBenchOnboardRoot(workspaceRootArg) {
  return path.join(workspaceRoot(workspaceRootArg), 'bench', 'onboard');
}

function legacyBenchOnboardOutDir(workspaceRootArg) {
  const root = workspaceRoot(workspaceRootArg);
  return path.join(root, 'bench', 'onboard', workspaceName(root));
}

module.exports = {
  workspaceName,
  workspaceRoot,
  onboardRuntimeRoot,
  defaultOnboardOutDir,
  legacyGraphOnboardOutDir,
  legacyBenchOnboardRoot,
  legacyBenchOnboardOutDir,
};
