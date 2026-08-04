'use strict';

const fs = require('fs');
const path = require('path');
const { preferWorkspaceId, repoRoot } = require('./workspace-registry');

function cleanString(value) {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function cleanPath(value) {
  const text = cleanString(value);
  if (!text) return null;
  try { return path.resolve(text); } catch { return null; }
}

function canonicalPath(value) {
  const resolved = cleanPath(value);
  if (!resolved) return null;
  try { return fs.realpathSync(resolved); } catch { return resolved; }
}

function canonicalGraphPath(value) {
  const resolved = cleanPath(value);
  if (!resolved) return null;
  return repoRoot(resolved) || canonicalPath(resolved);
}

function queryValue(u, key) {
  return u && u.searchParams && typeof u.searchParams.get === 'function'
    ? cleanString(u.searchParams.get(key))
    : null;
}

// Canonical request identity. `workspace` and `repo_path` remain accepted aliases, but are never
// separate sources of truth: workspace -> graph_repo and repo_path -> target_repo.
function fromRequest(body, u, defaults = {}) {
  const b = body && typeof body === 'object' ? body : {};
  const graphRepo = canonicalGraphPath(
    cleanString(b.graph_repo) || queryValue(u, 'graph_repo')
    || cleanString(b.workspace) || queryValue(u, 'workspace')
    || defaults.graph_repo || defaults.workspace
  );
  const targetRepo = cleanPath(
    cleanString(b.target_repo) || queryValue(u, 'target_repo')
    || cleanString(b.repo_path) || queryValue(u, 'repo_path')
    || defaults.target_repo || defaults.repo_path
  );
  return {
    workspace_id: cleanString(b.workspace_id) || queryValue(u, 'workspace_id')
      || cleanString(defaults.workspace_id),
    graph_repo: graphRepo,
    target_repo: targetRepo,
  };
}

function responseFields(identity = {}) {
  const graphRepo = canonicalGraphPath(identity.graph_repo || identity.workspace);
  const targetRepo = cleanPath(identity.target_repo || identity.repo_path);
  const out = {
    workspace_id: cleanString(identity.workspace_id),
    graph_repo: graphRepo,
    target_repo: targetRepo,
    // Deprecated response aliases retained during migration.
    workspace: graphRepo,
    repo_path: targetRepo,
  };
  return out;
}

function augmentBody(body, defaults = {}, { legacyOnly = false } = {}) {
  const original = body && typeof body === 'object' ? body : {};
  const identity = fromRequest(original, null, defaults);
  if (legacyOnly) {
    const aliases = {};
    if (identity.graph_repo && !original.workspace) aliases.workspace = identity.graph_repo;
    if (identity.target_repo && !original.repo_path) aliases.repo_path = identity.target_repo;
    return { ...aliases, ...original };
  }
  const fields = responseFields(identity);
  const present = Object.fromEntries(Object.entries(fields).filter(([, value]) => value != null));
  // Canonical values win over conflicting deprecated aliases, while caller values win over defaults.
  return { ...original, ...present };
}

function augmentUrl(rawPath, defaults = {}, { legacyOnly = false } = {}) {
  if (legacyOnly) {
    const graphRepo = cleanPath(defaults.graph_repo || defaults.workspace);
    const targetRepo = cleanPath(defaults.target_repo || defaults.repo_path);
    let out = rawPath;
    if (graphRepo && !/[?&]workspace=/.test(out)) {
      out += (out.includes('?') ? '&' : '?') + `workspace=${encodeURIComponent(graphRepo)}`;
    }
    if (targetRepo && /^\/(git\/|attempt\/diff)/.test(out) && !/[?&]repo_path=/.test(out)) {
      out += (out.includes('?') ? '&' : '?') + `repo_path=${encodeURIComponent(targetRepo)}`;
    }
    return out;
  }
  const url = new URL(rawPath, 'http://orchestrator.local');
  const identity = fromRequest(null, url, defaults);
  const fields = responseFields(identity);
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) url.searchParams.set(key, value);
  }
  return url.pathname + url.search;
}

function normalizeQuery(u) {
  if (!u || !u.searchParams) return u;
  const identity = fromRequest(null, u);
  const fields = responseFields(identity);
  for (const [key, value] of Object.entries(fields)) {
    if (value != null) u.searchParams.set(key, value);
  }
  return u;
}

function workspaceIdForRepo(registry, graphRepo) {
  const wanted = canonicalGraphPath(graphRepo);
  if (!wanted) return null;
  let selected = null;
  for (const [name, entry] of Object.entries((registry && registry.workspaces) || {})) {
    for (const repo of (entry && Array.isArray(entry.repos) ? entry.repos : [])) {
      if (canonicalGraphPath(repo) === wanted) selected = preferWorkspaceId(selected, name);
    }
  }
  return selected;
}

function unambiguousTargetRepo(registry, workspaceId, graphRepo) {
  const id = cleanString(workspaceId) || workspaceIdForRepo(registry, graphRepo);
  const entry = id && registry && registry.workspaces && registry.workspaces[id];
  if (!entry) return null;
  const unique = [...new Set((entry.repos || []).map(canonicalGraphPath).filter(Boolean))];
  const graph = canonicalGraphPath(graphRepo);
  return unique.length === 1 && graph === unique[0] ? graph : null;
}

function composeClientIdentity(identity, registry) {
  const normalized = fromRequest(identity || {}, null);
  const workspaceId = normalized.workspace_id || workspaceIdForRepo(registry, normalized.graph_repo);
  const targetRepo = normalized.target_repo
    || unambiguousTargetRepo(registry, workspaceId, normalized.graph_repo);
  return { workspace_id: workspaceId, graph_repo: normalized.graph_repo, target_repo: targetRepo };
}

module.exports = {
  augmentBody,
  augmentUrl,
  canonicalPath,
  composeClientIdentity,
  fromRequest,
  normalizeQuery,
  responseFields,
  unambiguousTargetRepo,
  workspaceIdForRepo,
};
