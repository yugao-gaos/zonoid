// Registry of follow-up consolidation rules. When apply() sees a follow-up that matches a rule,
// it coalesces into a stable bucket snapshot (singleton graph node) instead of minting a new
// followup/<slug>-<rand> key per parent completion. Precedent: followup/harness-judge-drain in
// routes/judge.js — stable key, idempotent ensure, snapshot substrate.
'use strict';
const overlay = require('./overlay');

const DAEMON_RESTART_KEY = 'followup/harness-daemon-restart';

function sourceEntry(parentKey, item) {
  return {
    parentKey,
    title: item.title,
    prompt: item.prompt,
    when: item.when || null,
    ts: new Date().toISOString(),
  };
}

function buildChangelog(sources) {
  return sources.map((s, i) => `${i + 1}. From ${s.parentKey}: ${s.title}`).join('\n');
}

function mergeDaemonDescription(existingDesc, item, changelog) {
  const base = String(existingDesc || '').split('\n\n--- Pending sources ---')[0].trim();
  const section = `\n\n---\nFrom ${item.title}:\n${item.prompt}`;
  return `${base}${section}\n\n--- Pending sources ---\n${changelog}`.trim();
}

const BUCKETS = [
  {
    id: 'daemon-restart',
    bucketKey: () => DAEMON_RESTART_KEY,
    match(f) {
      if (f.disruptive !== true) return false;
      const text = `${f.title}\n${f.prompt}`;
      return /restart.*(?:daemon|orchestrator)|(?:daemon|orchestrator).*restart/i.test(text);
    },
    guidanceSeverity: 'blocking', // destructive op — dashboard approval (pauses loop until answered)
    guidanceRejectable: false, // restart is all-or-nothing; no meaningful "reject" (task stays gated if you ignore it)
    guidanceQuestion: 'Restart orchestrator daemon',
    merge(existingSnapshot, newItem, parentKey) {
      const meta = { ...(existingSnapshot && existingSnapshot.metadata) || {} };
      const sources = Array.isArray(meta.sources) ? meta.sources.slice() : [];
      sources.push(sourceEntry(parentKey, newItem));
      meta.sources = sources;
      meta.follow_up_bucket = 'daemon-restart';
      meta.created_by = meta.created_by || 'daemon';
      const changelog = buildChangelog(sources);
      const description = existingSnapshot
        ? mergeDaemonDescription(existingSnapshot.description, newItem, changelog)
        : newItem.prompt;
      return {
        subject: (existingSnapshot && existingSnapshot.subject) || 'Restart orchestrator daemon',
        description,
        status: 'pending',
        blockedBy: [],
        owner: null,
        metadata: meta,
      };
    },
    onComplete(ov) {
      return cancelLegacySiblings(ov, this);
    },
  },
];

function findRule(item) {
  return BUCKETS.find((r) => r.match(item)) || null;
}

function findRuleById(id) {
  return BUCKETS.find((r) => r.id === id) || null;
}

function findRuleForKey(key) {
  return BUCKETS.find((r) => r.bucketKey() === key) || null;
}

// Cancel open legacy followup/* nodes that match the same rule but are not the bucket key.
function cancelLegacySiblings(ov, rule) {
  const bucketKey = rule.bucketKey(ov);
  const canceled = [];
  if (!ov.snapshots) return canceled;
  for (const [key, snap] of Object.entries(ov.snapshots)) {
    if (key === bucketKey) continue;
    if (!key.startsWith('followup/')) continue;
    const st = ov.status[key];
    if (st === 'canceled' || st === 'done') continue;
    const pseudo = { title: snap.subject || '', prompt: snap.description || '', disruptive: true };
    if (!rule.match(pseudo)) continue;
    overlay.setStatus(ov, key, 'canceled', `superseded by consolidated bucket ${bucketKey}`);
    ov.cancel_requested[key] = new Date().toISOString();
    canceled.push(key);
  }
  return canceled;
}

function findBucketGuidance(ov, bucketKey) {
  if (!Array.isArray(ov.guidance)) return null;
  return ov.guidance.find((g) => !g.resolved && g.action && g.action.kind === 'follow-up' && g.action.task_key === bucketKey) || null;
}

function updateBucketGuidance(ov, guidanceItem, item) {
  const append = `\n\nAdditional request: ${item.title}\n${item.prompt}${item.when ? `\nProposed timing: ${item.when}` : ''}`;
  guidanceItem.context = (String(guidanceItem.context || '') + append).slice(0, 2000);
}

function ensureBucketSnapshot(ov, rule, item, parentKey) {
  const key = rule.bucketKey(ov);
  const existing = ov.snapshots && ov.snapshots[key];
  overlay.setSnapshot(ov, key, rule.merge(existing, item, parentKey));
  if (ov.unwired) delete ov.unwired[key];
  return key;
}


function parentFromEdges(ov, key) {
  const e = (ov.edges || []).find((edge) => edge.to === key && edge.kind === 'context');
  return e ? e.from : null;
}

function repointEdgesToBucket(ov, legacyKeys, bucketKey) {
  const legacy = new Set(legacyKeys);
  for (const e of ov.edges || []) {
    if (!legacy.has(e.to)) continue;
    overlay.addEdge(ov, e.from, bucketKey, e.fromWorkspace || null, e.kind || 'context', e.weight);
  }
  ov.edges = (ov.edges || []).filter((e) => !legacy.has(e.to));
}

function resolveLegacyGuidance(ov, legacyKeys) {
  const legacy = new Set(legacyKeys);
  for (const g of ov.guidance || []) {
    if (g.resolved || !g.action || g.action.kind !== 'follow-up') continue;
    if (!legacy.has(g.action.task_key)) continue;
    g.resolved = true;
    g.resolvedAt = new Date().toISOString();
    g.answer = 'migrated to consolidated bucket';
  }
}

function ensureBucketGate(ov, rule, bucketKey, hadOpenHold) {
  if (!hadOpenHold) return null;
  overlay.setStatus(ov, bucketKey, 'not_ready', `disruptive follow-up bucket ${rule.id}: awaiting dashboard approval`);
  const existingG = findBucketGuidance(ov, bucketKey);
  if (existingG) return existingG.id;
  const severity = rule.guidanceSeverity || 'blocking';
  return overlay.addGuidance(ov, {
    question: rule.guidanceQuestion || 'Restart orchestrator daemon',
    context: String((ov.snapshots[bucketKey] && ov.snapshots[bucketKey].description) || '').slice(0, 2000),
    trigger: 'follow_up',
    severity,
    action: { kind: 'follow-up', task_key: bucketKey, bucket: rule.id },
  });
}

function migrateLegacyRestarts(ov) {
  const rule = findRuleById('daemon-restart');
  if (!rule) return { bucketKey: DAEMON_RESTART_KEY, migrated: [], canceled: [], guidance_id: null };
  const bucketKey = rule.bucketKey(ov);
  const legacyKeys = [];
  for (const [key, snap] of Object.entries(ov.snapshots || {})) {
    if (key === bucketKey) continue;
    if (!key.startsWith('followup/')) continue;
    const pseudo = { title: snap.subject || '', prompt: snap.description || '', disruptive: true };
    if (!rule.match(pseudo)) continue;
    legacyKeys.push(key);
  }
  if (!legacyKeys.length) {
    return { bucketKey, migrated: [], canceled: [], guidance_id: findBucketGuidance(ov, bucketKey)?.id || null, note: 'no legacy restart nodes' };
  }
  const openHolds = legacyKeys.filter((k) => ov.status[k] === 'not_ready');
  let existing = ov.snapshots && ov.snapshots[bucketKey];
  const migrated = [];
  for (const key of legacyKeys) {
    const snap = ov.snapshots[key];
    const parentKey = (snap.metadata && snap.metadata.follow_up_of) || parentFromEdges(ov, key) || key;
    const prompt = String(snap.description || '').split('\n\n--- Pending sources ---')[0].trim() || snap.description || '';
    const item = { title: snap.subject || key, prompt, disruptive: true };
    if (parentKey && parentKey !== bucketKey) overlay.addEdge(ov, parentKey, bucketKey, null, 'context');
    existing = rule.merge(existing, item, parentKey);
    migrated.push(key);
  }
  overlay.setSnapshot(ov, bucketKey, existing);
  if (ov.unwired) delete ov.unwired[bucketKey];
  repointEdgesToBucket(ov, legacyKeys, bucketKey);
  resolveLegacyGuidance(ov, legacyKeys);
  const canceled = cancelLegacySiblings(ov, rule);
  const guidance_id = ensureBucketGate(ov, rule, bucketKey, openHolds.length > 0 || ov.status[bucketKey] === 'not_ready');
  return { bucketKey, migrated, canceled, guidance_id, open_holds: openHolds.length };
}

const GATE_KINDS = {
  'daemon-restart': {
    satisfiedBy: 'daemon-boot',
    guidanceQuestion: 'Restart orchestrator daemon to activate pending changes',
  },
  'main-commit': {
    satisfiedBy: 'git-push',
    guidanceQuestion: 'Commit and push changes to main',
  },
  'human-approval': {
    satisfiedBy: 'manual',
    guidanceQuestion: 'Manual approval required',
  },
};

module.exports = {
  BUCKETS,
  GATE_KINDS,
  DAEMON_RESTART_KEY,
  findRule,
  findRuleById,
  findRuleForKey,
  cancelLegacySiblings,
  findBucketGuidance,
  updateBucketGuidance,
  ensureBucketSnapshot,
  migrateLegacyRestarts,
};
