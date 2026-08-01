'use strict';

// Default relevance weight for context edges (0..1). Pre-existing context edges with no stored
// `weight` read as this, so the field is backward-compatible (substrate for relevance traversal).
const DEFAULT_CONTEXT_WEIGHT = 0.5;

const KNOWLEDGE_NODE_TYPES = ['source_doc', 'source_section', 'source_chunk', 'knowledge_cluster'];
const KNOWLEDGE_NODE_TYPE_SET = new Set(KNOWLEDGE_NODE_TYPES);
const ENTITY_TYPES = new Set(['person', 'org', 'place', 'thing', 'concept']);

// edges: cross-session/workspace deps · status: richer-status overrides · notes: freeform
// summaries: on-complete "interface" summary per task (Tier-1 context) · knowledge: Tier-2
// context items per task · assignee: which agent is working a task (for live animation)
// timestamps: per-task { firstSeen, lastChanged, lastStatus } — daemon-observed task lifecycle
// features: per-feature-key { feature_branch, feature_worktree, base, createdAt, target? } — the feature-tier
//   integration surface (orch/feature/<key>) grouping a feature's attempt tasks. Workers fork
//   attempts off feature_branch and auto-merge back into it (tier-1); feature->main is gated (tier-2).
//   Lightweight record (no new node kind) — enough for the dashboard to show feature -> tasks.
// git: per-task { branch, worktree, head, createdAt, target? } — target records selection provenance
//   plus canonical path and Git common-dir identity for cross-repo safety.
// reviews: per-task same-node review lifecycle fields. Review is state on the implementation node,
//   not a separate visible judge task: { review_state, review_verdict, review_note/reason,
//   review_agent, reviewed_at, merge_state, attempt_branch/worktree/head, merge_sha, merged_at }.
// repos: per-task absolute path of the TARGET git repo the loop should branch/measure/merge on,
//   when it differs from the daemon workspace. Absent => fall back to the workspace (back-compat).
const EMPTY = () => ({
  edges: [],
  unwired: {},
  status: {},
  notes: {},
  summaries: {},
  knowledge: {},
  assignee: {},
  timestamps: {},
  config: {},
  git: {},
  reviews: {},
  features: {},
  repos: {},
  metrics: {},
  measurements: {},
  benchmarks: {},
  note_nodes: {},
  knowledge_nodes: {},
  code_nodes: {},
  code_edges: [],
  snapshots: {},
  cancel_requested: {},
  stop_requested: {},
  guidance: [],
  optimize: {},
  epoch: 0,
  judgedAtEpoch: {},
  judgeCursor: 0,
  judgedClusters: {},
  judgedTaskDecisions: {},
  distinctClusters: {},
  forceClaims: {},
  blocked: {},
  usage_records: {},
  task_costs: {},
  usage_reconcile: {},
  usage_reconcile_snapshot: null,
  dispatcher_focus: {},
  taskVecs: {},
  taskVecMeta: {},
  eagerJudge: {},
  judgingSince: {},
  edgeRejudge: {},
  eagerJudgeLease: {},
  spawnLease: {},
  planner: {},
  pendingDup: {},
  readinessRepairs: {},
  entity_nodes: {},
  claimSessions: {},
  git_claims: {},
  git_users: {},
  work_sessions: {},
});

function normalizeKnowledgeNodeType(type) {
  const t = String(type || '').trim().toLowerCase();
  return KNOWLEDGE_NODE_TYPE_SET.has(t) ? t : null;
}

function isKnowledgeNodeKind(kind) {
  return KNOWLEDGE_NODE_TYPE_SET.has(String(kind || '').trim().toLowerCase());
}

function isEntityNodeKind(kind) {
  return String(kind || '').trim().toLowerCase() === 'entity';
}

module.exports = {
  DEFAULT_CONTEXT_WEIGHT,
  EMPTY,
  ENTITY_TYPES,
  KNOWLEDGE_NODE_TYPES,
  KNOWLEDGE_NODE_TYPE_SET,
  isEntityNodeKind,
  isKnowledgeNodeKind,
  normalizeKnowledgeNodeType,
};
