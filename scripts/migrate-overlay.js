'use strict';
/**
 * One-time migration: read the shared fields from an existing overlay JSON file
 * and emit them as JSONL events into the graph-store (.graph/nodes/).
 *
 * Usage:
 *   node scripts/migrate-overlay.js <workspace-abs-path>
 *
 * Example:
 *   node scripts/migrate-overlay.js /Users/imyu/Desktop/cloude
 */

const fs         = require('fs');
const os         = require('os');
const path       = require('path');
const crypto     = require('crypto');
const graphStore = require('../lib/graph-store');

// ── resolve overlay file (mirrors overlay.js) ────────────────────────────────

const BASE = process.env.CLAUDE_PLUGIN_DATA || path.join(os.homedir(), '.claude', 'orchestrator');
const DIR  = path.join(BASE, 'overlay');

function encodeWorkspace(workspace) {
  // Mirrors lib/native-tasks encodeWorkspace: replace non-alphanum chars with '-'
  return String(workspace || '').replace(/[^A-Za-z0-9]/g, '-');
}

function fileFor(workspace) {
  const h    = crypto.createHash('sha1').update(String(workspace || '')).digest('hex').slice(0, 16);
  const base = (path.basename(String(workspace || '')) || 'ws').replace(/[^A-Za-z0-9._-]/g, '_');
  return path.join(DIR, `${base}-${h}.json`);
}

function legacyFileFor(workspace) {
  return path.join(DIR, `${encodeWorkspace(workspace)}.json`);
}

// ── main ─────────────────────────────────────────────────────────────────────

function main() {
  const workspace = process.argv[2];
  if (!workspace) {
    console.error('Usage: node scripts/migrate-overlay.js <workspace-abs-path>');
    process.exit(1);
  }

  // 1. Resolve overlay file path (hash-based first, then legacy fallback)
  let overlayFile = fileFor(workspace);
  if (!fs.existsSync(overlayFile)) {
    const legacy = legacyFileFor(workspace);
    if (fs.existsSync(legacy)) {
      overlayFile = legacy;
    } else {
      console.log('No overlay found for this workspace');
      process.exit(0);
    }
  }

  // 2. Read and parse overlay
  let overlay;
  try {
    overlay = JSON.parse(fs.readFileSync(overlayFile, 'utf8'));
  } catch (err) {
    console.error(`Failed to read overlay: ${err.message}`);
    process.exit(1);
  }

  const edges      = Array.isArray(overlay.edges)          ? overlay.edges          : [];
  const status     = overlay.status    && typeof overlay.status    === 'object' ? overlay.status    : {};
  const summaries  = overlay.summaries && typeof overlay.summaries === 'object' ? overlay.summaries : {};
  const knowledge  = overlay.knowledge && typeof overlay.knowledge === 'object' ? overlay.knowledge : {};
  const note_nodes = overlay.note_nodes && typeof overlay.note_nodes === 'object' ? overlay.note_nodes : {};
  const snapshots  = overlay.snapshots  && typeof overlay.snapshots  === 'object' ? overlay.snapshots  : {};

  // Compute totals for the summary line
  const knowledgeItems = Object.values(knowledge).reduce((n, items) => n + (Array.isArray(items) ? items.length : 0), 0);
  const noteItems      = Object.values(note_nodes).reduce((n, note) => n + (Array.isArray(note && note.knowledge) ? note.knowledge.length : 0), 0);

  // Show display path with ~ shorthand
  const home        = os.homedir();
  const displayPath = overlayFile.startsWith(home) ? `~${overlayFile.slice(home.length)}` : overlayFile;
  console.log(`Reading overlay: ${displayPath}`);
  console.log(`Found: ${edges.length} edges, ${Object.keys(status).length} status entries, ${Object.keys(summaries).length} summaries, ${Object.keys(knowledge).length} knowledge keys, ${Object.keys(note_nodes).length} note_nodes, ${Object.keys(snapshots).length} snapshots`);
  console.log();

  // 3. Open graph-store
  const store = graphStore.open(path.join(workspace, '.graph'));

  // 4. Load existing graph to determine which nodes already have events (idempotency)
  const existing = graphStore.loadGraph(store);
  const existingNodeIds = new Set([
    ...Object.keys(existing.nodes),
    ...Object.keys(existing.checkpointed),
  ]);

  // Helper: check if a node file already exists (has any lines) → skip
  function nodeFileExists(nodeId) {
    if (existingNodeIds.has(nodeId)) return true;
    // Also check the file directly in case the loadGraph missed it
    const file = path.join(store.nodesDir, `${nodeId}.jsonl`);
    try {
      const stat = fs.statSync(file);
      return stat.size > 0;
    } catch {
      return false;
    }
  }

  const ts = new Date().toISOString();
  let totalWritten = 0;

  // 5a. edges
  let edgeCount = 0;
  process.stdout.write('Migrating edges...       ');
  for (const e of edges) {
    const nodeId = e.from;
    if (!nodeId) continue;
    if (nodeFileExists(nodeId)) {
      console.error(`\n  already migrated, skipping ${nodeId}`);
      continue;
    }
    graphStore.appendEvent(store, nodeId, {
      evt:           'edge_added',
      from:          e.from,
      to:            e.to,
      kind:          e.kind || 'blocking',
      fromWorkspace: e.fromWorkspace,
      weight:        e.weight,
      actor:         'migration',
      ts,
    });
    edgeCount++;
  }
  console.log(`${edgeCount} events written`);
  totalWritten += edgeCount;

  // 5b. status
  let statusCount = 0;
  process.stdout.write('Migrating status...      ');
  for (const [key, st] of Object.entries(status)) {
    if (nodeFileExists(key)) {
      process.stderr.write(`\n  already migrated, skipping ${key}`);
      continue;
    }
    graphStore.appendEvent(store, key, {
      evt:   'status_changed',
      id:    key,
      status: st,
      actor: 'migration',
      ts,
    });
    statusCount++;
  }
  console.log(`${statusCount} events written`);
  totalWritten += statusCount;

  // 5c. summaries
  let summaryCount = 0;
  process.stdout.write('Migrating summaries...   ');
  for (const [key, summary] of Object.entries(summaries)) {
    if (nodeFileExists(key)) {
      process.stderr.write(`\n  already migrated, skipping ${key}`);
      continue;
    }
    graphStore.appendEvent(store, key, {
      evt:     'summary_set',
      id:      key,
      summary,
      actor:   'migration',
      ts,
    });
    summaryCount++;
  }
  console.log(`${summaryCount} events written`);
  totalWritten += summaryCount;

  // 5d. knowledge
  let knowledgeCount = 0;
  process.stdout.write('Migrating knowledge...   ');
  for (const [key, items] of Object.entries(knowledge)) {
    if (!Array.isArray(items)) continue;
    if (nodeFileExists(key)) {
      process.stderr.write(`\n  already migrated, skipping ${key}`);
      continue;
    }
    for (const item of items) {
      graphStore.appendEvent(store, key, {
        evt:   'knowledge_added',
        id:    key,
        item,
        actor: 'migration',
        ts,
      });
      knowledgeCount++;
    }
  }
  const knowledgeKeys = Object.keys(knowledge).length;
  const avgItems = knowledgeKeys > 0 ? (knowledgeCount / knowledgeKeys).toFixed(1) : '0';
  console.log(`${knowledgeCount} events written (${knowledgeKeys} keys × avg ${avgItems} items)`);
  totalWritten += knowledgeCount;

  // 5e. note_nodes
  let noteCount = 0;
  process.stdout.write('Migrating note_nodes...  ');
  for (const [id, note] of Object.entries(note_nodes)) {
    if (nodeFileExists(id)) {
      process.stderr.write(`\n  already migrated, skipping ${id}`);
      continue;
    }
    graphStore.appendEvent(store, id, {
      evt:        'note_created',
      id,
      title:      note.title,
      summary:    note.summary,
      created_by: note.created_by,
      valid_from: note.validFrom || note.valid_from || note.created_at,
      actor:      'migration',
      ts,
    });
    noteCount++;

    // Emit knowledge items attached to the note
    if (Array.isArray(note.knowledge)) {
      for (const item of note.knowledge) {
        graphStore.appendEvent(store, id, {
          evt:   'knowledge_added',
          id,
          item,
          actor: 'migration',
          ts,
        });
        noteCount++;
      }
    }
  }
  console.log(`${noteCount} events written`);
  totalWritten += noteCount;

  // 5f. snapshots
  let snapCount = 0;
  process.stdout.write('Migrating snapshots...   ');
  for (const [key, snap] of Object.entries(snapshots)) {
    if (nodeFileExists(key)) {
      process.stderr.write(`\n  already migrated, skipping ${key}`);
      continue;
    }
    graphStore.appendEvent(store, key, {
      evt:            'snapshot_stored',
      id:             key,
      subject:        snap.subject,
      description:    snap.description,
      status:         snap.status,
      blockedBy:      snap.blockedBy  || [],
      owner:          snap.owner      || null,
      metadata:       snap.metadata   || {},
      snapshotted_at: snap.snapshotted_at,
      actor:          'migration',
      ts,
    });
    snapCount++;
  }
  console.log(`${snapCount} events written`);
  totalWritten += snapCount;

  console.log();
  console.log(`Migration complete. ${totalWritten} events written to .graph/nodes/`);
  console.log('Run: git add .graph/ && git commit -m "chore: migrate graph history from overlay"');
}

main();
