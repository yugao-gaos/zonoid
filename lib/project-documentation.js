'use strict';

const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const MAX_DOCUMENT_BYTES = 512 * 1024;
const DOCUMENT_EXTENSIONS = new Set(['.md', '.mdx', '.rst', '.adoc']);
const ROOT_DOCUMENT_NAMES = /^(?:license|notice|changelog|security|code_of_conduct|governance)(?:\.[a-z0-9_-]+)?$/i;

class DocumentationError extends Error {
  constructor(code, message, status = 400) {
    super(message);
    this.name = 'DocumentationError';
    this.code = code;
    this.status = status;
  }
}

function normalizeRelativePath(value) {
  const raw = String(value || '').replace(/\\/g, '/');
  if (!raw || raw.includes('\0') || path.posix.isAbsolute(raw)) return null;
  const normalized = path.posix.normalize(raw);
  if (normalized === '.' || normalized === '..' || normalized.startsWith('../')) return null;
  if (normalized !== raw.replace(/^\.\//, '')) return null;
  return normalized;
}

function isDocumentationPath(value) {
  const relative = normalizeRelativePath(value);
  if (!relative) return false;
  const parts = relative.split('/');
  const extension = path.posix.extname(relative).toLowerCase();
  if (parts.length === 1 && ROOT_DOCUMENT_NAMES.test(parts[0])) return true;
  if (!DOCUMENT_EXTENSIONS.has(extension)) return false;
  if (parts.length === 1) return !/^(bench|report)[-_]/i.test(parts[0]);
  if (parts[0] === 'docs') return true;
  if (parts[0] === '.github') return true;
  if (parts[0] === 'schemas' && parts.length === 2 && /^readme\./i.test(parts[1])) return true;
  if ((parts[0] === 'packages' || parts[0] === 'adapters')
      && parts.length === 3 && /^readme\./i.test(parts[2])) return true;
  return false;
}

function contentHash(content) {
  return crypto.createHash('sha256').update(content).digest('hex');
}

function trackedDocumentationPaths(workspace) {
  let output;
  try {
    output = execFileSync('git', ['-C', workspace, 'ls-files', '-z', '--', '*.md', '*.mdx', '*.rst', '*.adoc', 'LICENSE*', 'NOTICE*', 'CHANGELOG*', 'SECURITY*', 'CODE_OF_CONDUCT*', 'GOVERNANCE*'], {
      encoding: 'buffer',
      maxBuffer: 8 * 1024 * 1024,
      stdio: ['ignore', 'pipe', 'ignore'],
    });
  } catch {
    throw new DocumentationError('not_a_git_repository', 'Documentation is available only for a Git workspace.', 400);
  }
  return output.toString('utf8').split('\0').filter(Boolean).filter(isDocumentationPath).sort((a, b) => a.localeCompare(b));
}

function workspaceRoot(workspace) {
  if (!workspace) throw new DocumentationError('workspace_required', 'workspace required', 400);
  try {
    const root = fs.realpathSync(String(workspace));
    if (!fs.statSync(root).isDirectory()) throw new Error('not a directory');
    return root;
  } catch {
    throw new DocumentationError('workspace_unavailable', 'Workspace is not a readable directory.', 404);
  }
}

function resolveTrackedDocument(workspace, requestedPath, trackedPaths = null) {
  const root = workspaceRoot(workspace);
  const relative = normalizeRelativePath(requestedPath);
  if (!relative || !isDocumentationPath(relative)) {
    throw new DocumentationError('invalid_document_path', 'Document path is outside the project documentation set.', 400);
  }
  const tracked = trackedPaths || trackedDocumentationPaths(root);
  if (!tracked.includes(relative)) {
    throw new DocumentationError('document_not_found', 'Document is not a tracked project documentation file.', 404);
  }
  const candidate = path.join(root, ...relative.split('/'));
  let stat;
  let real;
  try {
    stat = fs.lstatSync(candidate);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('not a regular file');
    real = fs.realpathSync(candidate);
  } catch {
    throw new DocumentationError('document_not_found', 'Document is not a readable regular file.', 404);
  }
  const prefix = root.endsWith(path.sep) ? root : root + path.sep;
  if (!real.startsWith(prefix)) {
    throw new DocumentationError('document_outside_workspace', 'Document resolves outside the workspace.', 403);
  }
  if (stat.size > MAX_DOCUMENT_BYTES) {
    throw new DocumentationError('document_too_large', `Document exceeds the ${MAX_DOCUMENT_BYTES}-byte editor limit.`, 413);
  }
  return { root, relative, file: real, stat };
}

function titleFromContent(content, relative) {
  const heading = String(content).match(/^\s{0,3}#{1,2}\s+(.+?)\s*#*\s*$/m);
  return heading ? heading[1].trim() : path.posix.basename(relative);
}

function sectionFor(relative) {
  const parts = relative.split('/');
  if (parts.length === 1) return 'Project';
  if (parts[0] === 'docs') return 'Docs';
  if (parts[0] === '.github') return 'GitHub';
  if (parts[0] === 'packages') return 'Packages';
  if (parts[0] === 'adapters') return 'Adapters';
  if (parts[0] === 'schemas') return 'Schemas';
  return 'Project';
}

function readDocument(workspace, requestedPath, trackedPaths = null) {
  const resolved = resolveTrackedDocument(workspace, requestedPath, trackedPaths);
  let content;
  try {
    content = fs.readFileSync(resolved.file, 'utf8');
  } catch {
    throw new DocumentationError('document_unreadable', 'Document could not be read as UTF-8 text.', 422);
  }
  const stat = fs.statSync(resolved.file);
  return {
    path: resolved.relative,
    title: titleFromContent(content, resolved.relative),
    section: sectionFor(resolved.relative),
    size: Buffer.byteLength(content),
    modified_at: stat.mtime.toISOString(),
    hash: contentHash(content),
    content,
  };
}

function listDocuments(workspace) {
  const root = workspaceRoot(workspace);
  const tracked = trackedDocumentationPaths(root);
  const documents = [];
  for (const relative of tracked) {
    try {
      const document = readDocument(root, relative, tracked);
      documents.push({
        path: document.path,
        title: document.title,
        section: document.section,
        size: document.size,
        modified_at: document.modified_at,
        hash: document.hash,
      });
    } catch (error) {
      if (!(error instanceof DocumentationError)) throw error;
    }
  }
  const sectionOrder = new Map(['Project', 'Docs', 'Packages', 'Adapters', 'Schemas', 'GitHub'].map((name, index) => [name, index]));
  return documents.sort((a, b) => (sectionOrder.get(a.section) ?? 99) - (sectionOrder.get(b.section) ?? 99)
    || a.path.localeCompare(b.path));
}

function writeDocument(workspace, requestedPath, content, expectedHash) {
  if (typeof content !== 'string') {
    throw new DocumentationError('content_required', 'Document content must be a string.', 400);
  }
  if (Buffer.byteLength(content) > MAX_DOCUMENT_BYTES) {
    throw new DocumentationError('document_too_large', `Document exceeds the ${MAX_DOCUMENT_BYTES}-byte editor limit.`, 413);
  }
  if (!/^[a-f0-9]{64}$/i.test(String(expectedHash || ''))) {
    throw new DocumentationError('expected_hash_required', 'A valid expected_hash is required for conflict-safe editing.', 400);
  }

  const root = workspaceRoot(workspace);
  const tracked = trackedDocumentationPaths(root);
  const current = readDocument(root, requestedPath, tracked);
  if (current.hash !== String(expectedHash).toLowerCase()) {
    throw new DocumentationError('document_conflict', 'Document changed on disk. Reload it before saving.', 409);
  }
  const resolved = resolveTrackedDocument(root, requestedPath, tracked);
  if (contentHash(fs.readFileSync(resolved.file)) !== String(expectedHash).toLowerCase()) {
    throw new DocumentationError('document_conflict', 'Document changed on disk. Reload it before saving.', 409);
  }
  const temp = path.join(path.dirname(resolved.file), `.${path.basename(resolved.file)}.zonoid-${process.pid}-${crypto.randomBytes(6).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(temp, content, { encoding: 'utf8', flag: 'wx', mode: resolved.stat.mode });
    fs.renameSync(temp, resolved.file);
  } finally {
    try { fs.unlinkSync(temp); } catch { /* already renamed or absent */ }
  }
  return readDocument(root, requestedPath, tracked);
}

module.exports = {
  MAX_DOCUMENT_BYTES,
  DocumentationError,
  normalizeRelativePath,
  isDocumentationPath,
  contentHash,
  listDocuments,
  readDocument,
  writeDocument,
};
