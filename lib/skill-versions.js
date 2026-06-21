'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const STORE_VERSION = 1;

function cleanString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function normalizeLineEndings(value) {
  return String(value || '').replace(/\r\n?/g, '\n');
}

function hash(value, length = 24) {
  return crypto.createHash('sha256').update(String(value)).digest('hex').slice(0, length);
}

function slugify(value) {
  return cleanString(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

function extractFrontmatterName(markdown) {
  const text = normalizeLineEndings(markdown);
  const match = text.match(/^---\n([\s\S]*?)\n---(?:\n|$)/);
  if (!match) return '';
  for (const line of match[1].split('\n')) {
    const m = line.match(/^\s*name\s*:\s*["']?([^"'\n#]+)["']?\s*(?:#.*)?$/i);
    if (m) return cleanString(m[1]);
  }
  return '';
}

function skillNameFromPath(value) {
  const raw = cleanString(value);
  if (!raw) return '';
  const parsed = path.parse(raw);
  if (parsed.base.toLowerCase() === 'skill.md') return path.basename(parsed.dir);
  return parsed.name || parsed.base;
}

function skillIdentity(input = {}) {
  const explicit = cleanString(input.skill_id || input.identity || input.key);
  if (explicit) {
    const slug = slugify(explicit.replace(/^skill:/, ''));
    if (slug) return { skill_id: `skill:${slug}`, slug, source: 'explicit', value: explicit };
  }

  const pathName = skillNameFromPath(input.skill_path || input.target_path || input.path);
  const name = cleanString(input.name || input.skill_name || input.title);
  const frontmatterName = extractFrontmatterName(input.skill_markdown || input.markdown || input.content);
  const candidates = [
    ['path', pathName],
    ['name', name],
    ['frontmatter', frontmatterName],
  ];

  for (const [source, value] of candidates) {
    const slug = slugify(value);
    if (slug) return { skill_id: `skill:${slug}`, slug, source, value: cleanString(value) };
  }

  throw new Error('skill identity requires skill_id, skill_path, name, or skill markdown frontmatter name');
}

function sameSkillIdentity(a, b) {
  return skillIdentity(a).skill_id === skillIdentity(b).skill_id;
}

function storeDir(workspace) {
  const ws = cleanString(workspace);
  if (!ws) throw new Error('workspace is required');
  return path.join(ws, '.graph', 'skill-versions');
}

function pathsFor(workspace) {
  const dir = storeDir(workspace);
  return {
    dir,
    versions: path.join(dir, 'versions.jsonl'),
    manifest: path.join(dir, 'manifest.json'),
  };
}

function atomicWrite(dest, content) {
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, content);
  fs.renameSync(tmp, dest);
}

function emptyManifest() {
  return { version: STORE_VERSION, skills: {} };
}

function coerceManifest(parsed) {
  if (!parsed || typeof parsed !== 'object' || parsed.version !== STORE_VERSION || !parsed.skills || typeof parsed.skills !== 'object') {
    return emptyManifest();
  }
  const manifest = emptyManifest();
  for (const [skillId, entry] of Object.entries(parsed.skills)) {
    if (!skillId.startsWith('skill:') || !entry || typeof entry !== 'object') continue;
    const versionIds = Array.isArray(entry.version_ids)
      ? [...new Set(entry.version_ids.filter((id) => typeof id === 'string' && id))]
      : [];
    manifest.skills[skillId] = {
      skill_id: skillId,
      slug: cleanString(entry.slug) || skillId.slice('skill:'.length),
      active_version_id: versionIds.includes(entry.active_version_id) ? entry.active_version_id : null,
      latest_version_id: versionIds.includes(entry.latest_version_id) ? entry.latest_version_id : (versionIds[versionIds.length - 1] || null),
      version_ids: versionIds,
      created_at: cleanString(entry.created_at) || null,
      updated_at: cleanString(entry.updated_at) || null,
      active_updated_at: cleanString(entry.active_updated_at) || null,
      active_provenance: entry.active_provenance && typeof entry.active_provenance === 'object' ? entry.active_provenance : null,
      activation_history: Array.isArray(entry.activation_history) ? entry.activation_history.filter(Boolean) : [],
    };
  }
  return manifest;
}

function loadManifest(workspace) {
  const { manifest } = pathsFor(workspace);
  try {
    return coerceManifest(JSON.parse(fs.readFileSync(manifest, 'utf8')));
  } catch {
    return emptyManifest();
  }
}

function readVersionRecords(workspace) {
  const { versions } = pathsFor(workspace);
  let raw;
  try { raw = fs.readFileSync(versions, 'utf8'); } catch { return []; }
  const records = [];
  for (const line of raw.split('\n')) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line);
      if (record && typeof record === 'object' && typeof record.version_id === 'string') records.push(record);
    } catch { /* ignore partial/corrupt rows */ }
  }
  return records;
}

function writeManifest(workspace, manifest) {
  atomicWrite(pathsFor(workspace).manifest, JSON.stringify(coerceManifest(manifest), null, 2));
}

function versionIdForSkill(skillId, markdown) {
  const bodyHash = hash(normalizeLineEndings(markdown), 64);
  return `skv_${hash(`${skillId}\0${bodyHash}`)}`;
}

function normalizeProvenance(input = {}, now) {
  const source = input.provenance && typeof input.provenance === 'object' ? input.provenance : {};
  return {
    created_at: now,
    generated_by: cleanString(source.generated_by || input.generated_by || input.agent_id) || null,
    task_key: cleanString(source.task_key || input.task_key) || null,
    source: cleanString(source.source || input.source) || null,
    prompt_hash: cleanString(source.prompt_hash || input.prompt_hash) || null,
    candidate_key: cleanString(source.candidate_key || input.candidate_key) || null,
  };
}

function ensureManifestEntry(manifest, identity, now) {
  let entry = manifest.skills[identity.skill_id];
  if (!entry) {
    entry = {
      skill_id: identity.skill_id,
      slug: identity.slug,
      active_version_id: null,
      latest_version_id: null,
      version_ids: [],
      created_at: now,
      updated_at: now,
      active_updated_at: null,
      active_provenance: null,
      activation_history: [],
    };
    manifest.skills[identity.skill_id] = entry;
  }
  return entry;
}

function recordGeneratedSkillVersion(workspace, input = {}) {
  const identity = skillIdentity(input);
  const skillMarkdown = normalizeLineEndings(input.skill_markdown || input.markdown || input.content);
  if (!skillMarkdown.trim()) throw new Error('skill markdown is required');

  const now = cleanString(input.now) || new Date().toISOString();
  const bodyHash = hash(skillMarkdown, 64);
  const versionId = versionIdForSkill(identity.skill_id, skillMarkdown);
  const existing = readVersionRecords(workspace).find((record) => record.version_id === versionId);
  const manifest = loadManifest(workspace);
  const entry = ensureManifestEntry(manifest, identity, now);

  if (!entry.version_ids.includes(versionId)) entry.version_ids.push(versionId);
  entry.latest_version_id = versionId;
  entry.updated_at = now;

  if (existing) {
    writeManifest(workspace, manifest);
    return { ok: true, created: false, record: existing, manifest };
  }

  const record = {
    schema_version: STORE_VERSION,
    version_id: versionId,
    skill_id: identity.skill_id,
    slug: identity.slug,
    identity_source: identity.source,
    identity_value: identity.value,
    skill_path: cleanString(input.skill_path || input.target_path || input.path) || null,
    body_hash: bodyHash,
    skill_markdown: skillMarkdown,
    provenance: normalizeProvenance(input, now),
    created_at: now,
  };

  fs.mkdirSync(pathsFor(workspace).dir, { recursive: true });
  fs.appendFileSync(pathsFor(workspace).versions, JSON.stringify(record) + '\n');
  writeManifest(workspace, manifest);

  return { ok: true, created: true, record, manifest };
}

function findVersion(workspace, versionId) {
  return readVersionRecords(workspace).find((record) => record.version_id === versionId) || null;
}

function listSkillVersions(workspace, input = {}) {
  const identity = skillIdentity(input);
  return readVersionRecords(workspace).filter((record) => record.skill_id === identity.skill_id);
}

function setActiveSkillVersion(workspace, input = {}) {
  const versionId = cleanString(input.version_id);
  if (!versionId) throw new Error('version_id is required');
  const record = findVersion(workspace, versionId);
  if (!record) throw new Error(`unknown skill version: ${versionId}`);

  const identity = input.skill_id || input.identity || input.key || input.skill_path || input.target_path || input.path || input.name || input.skill_name || input.title
    ? skillIdentity(input)
    : { skill_id: record.skill_id, slug: record.slug || record.skill_id.slice('skill:'.length) };
  if (identity.skill_id !== record.skill_id) throw new Error('version_id does not belong to the requested skill');

  const now = cleanString(input.now) || new Date().toISOString();
  const manifest = loadManifest(workspace);
  const entry = ensureManifestEntry(manifest, identity, now);
  if (!entry.version_ids.includes(versionId)) entry.version_ids.push(versionId);
  entry.active_version_id = versionId;
  entry.latest_version_id = entry.latest_version_id || versionId;
  entry.updated_at = now;
  entry.active_updated_at = now;
  entry.active_provenance = {
    activated_at: now,
    activated_by: cleanString(input.activated_by || input.agent_id) || null,
    task_key: cleanString(input.task_key) || null,
    reason: cleanString(input.reason) || null,
  };
  entry.activation_history.push({ ...entry.active_provenance, version_id: versionId });

  writeManifest(workspace, manifest);
  return { ok: true, active_version: record, manifest };
}

function getActiveSkillVersion(workspace, input = {}) {
  const identity = skillIdentity(input);
  const manifest = loadManifest(workspace);
  const entry = manifest.skills[identity.skill_id];
  if (!entry || !entry.active_version_id) return null;
  return findVersion(workspace, entry.active_version_id);
}

module.exports = {
  STORE_VERSION,
  extractFrontmatterName,
  skillIdentity,
  sameSkillIdentity,
  versionIdForSkill,
  pathsFor,
  loadManifest,
  readVersionRecords,
  recordGeneratedSkillVersion,
  listSkillVersions,
  setActiveSkillVersion,
  getActiveSkillVersion,
};
