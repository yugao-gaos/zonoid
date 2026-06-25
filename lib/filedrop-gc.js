// Shared file-drop stub GC: adopt snapshots, detect terminal state, remove mint artifacts.
'use strict';
const overlayStore = require('./overlay');
const filedrop = require('./filedrop-tasks');

const TERMINAL_OVERLAY = new Set(['done', 'tested', 'failed', 'canceled']);
const TERMINAL_NATIVE_STUB = 'completed';

function adoptStubIfNeeded(ov, workspace, key) {
  const k = String(key);
  if (ov.snapshots && ov.snapshots[k]) return false;
  const fd = filedrop.readTask(workspace, k);
  if (!fd) return false;
  const parts = filedrop.splitKey(k);
  overlayStore.setSnapshot(ov, k, {
    subject: fd.subject || String(fd.id),
    description: fd.description || '',
    status: fd.status || 'pending',
    blockedBy: filedrop.normalizeDeps(parts ? parts.harness : '', fd.blockedBy),
    owner: fd.owner ?? null,
    metadata: fd.metadata ?? null,
  });
  return true;
}

function isTerminalForGc(ov, key) {
  const k = String(key);
  const overlayStatus = ov.status && ov.status[k];
  if (overlayStatus && TERMINAL_OVERLAY.has(overlayStatus)) return true;
  if (overlayStatus === 'in_progress') return false;
  const snap = ov.snapshots && ov.snapshots[k];
  return !!(snap && snap.status === TERMINAL_NATIVE_STUB);
}

function removeStubIfSnapshotted(workspace, key, ov) {
  const k = String(key);
  if (!ov.snapshots || !ov.snapshots[k]) return false;
  if (!filedrop.readStub(workspace, k)) return false;
  return filedrop.removeStub(workspace, k);
}

function sweepWorkspaceStubs(workspace, ov, { dryRun = false } = {}) {
  const adopted = [];
  const removed = [];
  const skipped = [];
  for (const key of filedrop.listStubKeys(workspace)) {
    if (adoptStubIfNeeded(ov, workspace, key)) adopted.push(key);
    if (!isTerminalForGc(ov, key)) { skipped.push(key); continue; }
    if (!filedrop.readStub(workspace, key)) { skipped.push(key); continue; }
    if (dryRun) { removed.push(key); continue; }
    if (filedrop.removeStub(workspace, key)) removed.push(key);
    else skipped.push(key);
  }
  return { adopted, removed, skipped };
}

module.exports = {
  TERMINAL_OVERLAY,
  TERMINAL_NATIVE_STUB,
  adoptStubIfNeeded,
  isTerminalForGc,
  removeStubIfSnapshotted,
  sweepWorkspaceStubs,
};
