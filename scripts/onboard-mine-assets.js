#!/usr/bin/env node
'use strict';
// onboard-mine-assets.js — static miner for BINARY-ASSET knowledge (images, models, audio,
// engine files, large data tables).
//
// Assets are the domain where reading the repo recovers the LEAST semantics: code never explains
// WHY a texture is 8MB, which atlas a sprite belongs to, or why model_v3.fbx replaced model_v2.fbx.
// That makes asset facts exactly the "non-recoverable without the repo" knowledge the onboarding
// KB is for. This miner emits candidate hypotheses over four cheap, text-tools-only signal classes:
//
//   1. inventory   — per-class counts/sizes, where each class lives, naming conventions
//                    (common filename prefixes/suffixes).
//   2. outliers    — assets >5x the median size of their class; image dimensions via macOS `sips`
//                    (skipped silently when sips is unavailable or a file doesn't parse).
//   3. churn       — git history: frequently-replaced assets + commit messages that carry
//                    rationale ("compressed X because …", reverts).
//   4. references  — grep asset basenames through code/text files: most-referenced assets and
//                    apparent orphans (never referenced anywhere).
//
// Output volume is capped per class (see CAPS) and every capped summary says so.
//
//   node scripts/onboard-mine-assets.js --repo <abs> [--out <dir>]
//
// Emits <out>/asset-notes.json = [{title, summary, kind:'asset', source}] (same shape the other
// miners use, so onboard-learn.js's gatherCandidates picks it up). No graph mutation, no commit.

const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const SELF_REPO = path.resolve(__dirname, '..');
const SKIP_DIRS = new Set(['node_modules', 'worktrees', '.git', 'dist', 'build', 'coverage', 'vendor', '.next', 'out', 'tmp', '__pycache__']);

const ASSET_CLASSES = {
  image: new Set(['.png', '.jpg', '.jpeg', '.tga', '.psd', '.webp']),
  model: new Set(['.fbx', '.obj', '.gltf', '.glb', '.blend']),
  audio: new Set(['.wav', '.ogg', '.mp3']),
  engine: new Set(['.meta', '.tscn', '.prefab', '.unity', '.uasset', '.tres']),
  data: new Set(['.csv', '.tsv', '.json']), // only counted when >= DATA_MIN_BYTES
};
const DATA_MIN_BYTES = 64 * 1024;          // .csv/.tsv/.json smaller than this is config, not an asset
const OUTLIER_FACTOR = 5;                  // flag assets > 5x their class median
const OUTLIER_MIN_BYTES = 100 * 1024;      // …but never flag tiny files as outliers
const CODE_EXT = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx', '.jsx', '.json', '.css', '.html', '.md',
  '.c', '.cc', '.cpp', '.h', '.hpp', '.cs', '.py', '.gd', '.lua', '.rs', '.go', '.java', '.kt', '.swift',
  '.tscn', '.tres', '.prefab', '.unity', '.yaml', '.yml', '.xml', '.shader', '.glsl']);
const CAPS = {
  outliers: 10,        // top outliers overall
  churn: 8,            // most-replaced assets
  rationale: 8,        // asset-touching commits with rationale text
  orphansPerClass: 12, // unreferenced assets listed per class
  referenced: 8,       // most-referenced assets
  sipsImages: 40,      // largest images probed for dimensions
  refAssets: 1000,     // asset basenames matched through code (largest first)
  codeFileBytes: 512 * 1024, // skip code files bigger than this when grepping
};

function arg(name, def) {
  const i = process.argv.indexOf('--' + name);
  return i >= 0 && i + 1 < process.argv.length ? process.argv[i + 1] : def;
}

function classify(ext) {
  for (const [cls, exts] of Object.entries(ASSET_CLASSES)) if (exts.has(ext)) return cls;
  return null;
}

function walk(repo, dir, assets, codeFiles) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    if (e.name.startsWith('.')) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) { if (!SKIP_DIRS.has(e.name)) walk(repo, full, assets, codeFiles); continue; }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    const rel = path.relative(repo, full).split(path.sep).join('/');
    const cls = classify(ext);
    if (cls) {
      let size = 0;
      try { size = fs.statSync(full).size; } catch { /* ignore */ }
      if (cls === 'data' && size < DATA_MIN_BYTES) {
        // small structured-text file: not an asset, but still a grep target
        if (CODE_EXT.has(ext)) codeFiles.push(rel);
        continue;
      }
      assets.push({ rel, ext, cls, size, base: e.name });
    } else if (CODE_EXT.has(ext)) {
      codeFiles.push(rel);
    }
  }
}

function human(bytes) {
  if (bytes >= 1024 * 1024) return (bytes / (1024 * 1024)).toFixed(1) + 'MB';
  if (bytes >= 1024) return Math.round(bytes / 1024) + 'KB';
  return bytes + 'B';
}

function median(nums) {
  if (!nums.length) return 0;
  const s = [...nums].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

function topCounts(map, n) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]).slice(0, n);
}

// ---- 1. inventory + naming/directory conventions --------------------------------------------
function nameTokens(base) {
  return base.replace(/\.[^.]+$/, '').split(/[_\-. ]+/).filter((t) => t && !/^\d+$/.test(t));
}

function mineInventory(assets, out) {
  const byClass = new Map();
  for (const a of assets) {
    if (!byClass.has(a.cls)) byClass.set(a.cls, []);
    byClass.get(a.cls).push(a);
  }
  for (const [cls, list] of byClass) {
    const total = list.reduce((s, a) => s + a.size, 0);
    const dirs = new Map();
    const prefixes = new Map();
    const suffixes = new Map();
    for (const a of list) {
      const dir = path.posix.dirname(a.rel);
      dirs.set(dir, (dirs.get(dir) || 0) + 1);
      const toks = nameTokens(a.base);
      if (toks.length > 1) {
        prefixes.set(toks[0], (prefixes.get(toks[0]) || 0) + 1);
        suffixes.set(toks[toks.length - 1], (suffixes.get(toks[toks.length - 1]) || 0) + 1);
      }
    }
    const topDirs = topCounts(dirs, 3).map(([d, n]) => `${d}/ (${n})`).join(', ');
    const conv = [];
    for (const [tok, n] of topCounts(prefixes, 3)) if (n >= 3 && n >= list.length * 0.2) conv.push(`prefix '${tok}_' x${n}`);
    for (const [tok, n] of topCounts(suffixes, 3)) if (n >= 3 && n >= list.length * 0.2) conv.push(`suffix '_${tok}' x${n}`);
    out.push({
      title: `Asset inventory: ${list.length} ${cls} file(s), ${human(total)}`,
      summary: `${cls} assets live mainly in: ${topDirs}.` +
        (conv.length ? ` Naming conventions: ${conv.join('; ')}.` : ' No dominant naming convention detected.') +
        ` Verify whether the directory/naming scheme is a real project convention worth a note, and keep only if non-obvious.`,
      kind: 'asset',
      source: `asset-scan:${cls}`,
    });
  }
}

// ---- 2. size/dimension stats + outliers ------------------------------------------------------
let SIPS_OK = null;
function sipsAvailable() {
  if (SIPS_OK === null) {
    const r = spawnSync('sips', ['--help'], { encoding: 'utf8', windowsHide: true });
    SIPS_OK = !r.error && r.status === 0;
  }
  return SIPS_OK;
}

function imageDims(abs) {
  if (!sipsAvailable()) return null;
  const r = spawnSync('sips', ['-g', 'pixelWidth', '-g', 'pixelHeight', abs], { encoding: 'utf8', windowsHide: true });
  if (r.error || r.status !== 0) return null; // fake/corrupt image: degrade silently
  const w = (r.stdout.match(/pixelWidth:\s*(\d+)/) || [])[1];
  const h = (r.stdout.match(/pixelHeight:\s*(\d+)/) || [])[1];
  return w && h ? `${w}x${h}` : null;
}

function mineOutliers(repo, assets, out) {
  const byClass = new Map();
  for (const a of assets) {
    if (!byClass.has(a.cls)) byClass.set(a.cls, []);
    byClass.get(a.cls).push(a);
  }
  const dims = new Map(); // rel -> WxH for the largest images
  const images = (byClass.get('image') || []).slice().sort((a, b) => b.size - a.size).slice(0, CAPS.sipsImages);
  for (const a of images) {
    const d = imageDims(path.join(repo, a.rel));
    if (d) dims.set(a.rel, d);
  }
  const outliers = [];
  for (const [cls, list] of byClass) {
    const med = median(list.map((a) => a.size));
    for (const a of list) {
      if (a.size >= OUTLIER_MIN_BYTES && med > 0 && a.size > OUTLIER_FACTOR * med) {
        outliers.push({ ...a, med });
      }
    }
  }
  outliers.sort((a, b) => b.size / b.med - a.size / a.med);
  const capped = outliers.length > CAPS.outliers;
  for (const a of outliers.slice(0, CAPS.outliers)) {
    const dim = dims.get(a.rel) ? ` (${dims.get(a.rel)})` : '';
    out.push({
      title: `Asset size outlier: ${a.base} is ${human(a.size)}${dim}`,
      summary: `${a.rel} is ${human(a.size)}${dim}, >${OUTLIER_FACTOR}x the ${a.cls}-class median of ${human(a.med)}. ` +
        `An asset this far off its class norm usually has a reason (uncompressed source, atlas, raw capture) — find WHY or flag it.` +
        (capped ? ` [outlier list capped at ${CAPS.outliers} of ${outliers.length}]` : ''),
      kind: 'asset',
      source: a.rel,
    });
  }
}

// ---- 3. churn + rationale from git history ---------------------------------------------------
const REC_SEP = '\x1e';
const FLD_SEP = '\x1f';
const RATIONALE_RE = /resiz|compress|optimi[sz]|replac|shrink|reduc|revert|atlas|sprite|upscal|downscal|re-?export|re-?encode|too (?:big|large|heavy)|smaller|lighter/i;

function isAssetPath(p) {
  const ext = path.extname(p).toLowerCase();
  const cls = classify(ext);
  return cls && cls !== 'data'; // history can't tell data-file size cheaply; skip that class here
}

function mineChurn(repo, out) {
  const fmt = `${REC_SEP}%h${FLD_SEP}%s${FLD_SEP}%b${FLD_SEP}`;
  const r = spawnSync('git', ['-C', repo, 'log', '--diff-filter=AMD', `--pretty=format:${fmt}`, '--name-status', '-n', '3000'],
    { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, windowsHide: true });
  if (r.error || r.status !== 0) return; // not a git repo / shallow oddities: skip churn class
  const modCount = new Map(); // asset path -> times Modified (i.e. replaced in place)
  const rationale = [];
  for (const rec of r.stdout.split(REC_SEP)) {
    if (!rec.trim()) continue;
    // fmt = sha FLD subject FLD body FLD <name-status>: split() consumes every FLD, so the
    // name-status block is parts[3] (NOT embedded in parts[2]).
    const parts = rec.split(FLD_SEP);
    if (parts.length < 4) continue;
    const sha = parts[0], subject = parts[1] || '', body = parts[2] || '';
    const after = parts.slice(3).join(FLD_SEP);
    const touched = after.split('\n').map((l) => l.trim()).filter((l) => /^[A-Z]\d*\t/.test(l))
      .map((l) => { const p = l.split('\t'); return { status: p[0][0], path: p[p.length - 1] }; })
      .filter((f) => isAssetPath(f.path));
    if (!touched.length) continue;
    for (const f of touched) if (f.status === 'M') modCount.set(f.path, (modCount.get(f.path) || 0) + 1);
    const msg = `${subject} ${body}`.trim();
    if (RATIONALE_RE.test(msg) && rationale.length < CAPS.rationale * 3) {
      rationale.push({ sha: (sha || '').trim(), subject: (subject || '').trim(), files: touched.slice(0, 4).map((f) => f.path) });
    }
  }
  const hot = topCounts(modCount, CAPS.churn).filter(([, n]) => n >= 2);
  for (const [p, n] of hot) {
    out.push({
      title: `Frequently replaced asset: ${path.posix.basename(p)} (${n}x)`,
      summary: `${p} was modified/replaced ${n} times in the last ~3000 commits. Repeated replacement of a binary asset usually tracks an iteration loop (art revisions, compression passes) — check the commits for the why. [top ${CAPS.churn} by churn]`,
      kind: 'asset',
      source: p,
    });
  }
  for (const c of rationale.slice(0, CAPS.rationale)) {
    out.push({
      title: `Asset-change rationale: ${c.subject.slice(0, 70)}`,
      summary: `Commit ${c.sha} touched asset(s) ${c.files.join(', ')} with a message implying a deliberate asset decision: "${c.subject}". Verify the rationale (size/quality/format tradeoff) and keep only if it explains something the file itself cannot. [rationale commits capped at ${CAPS.rationale}]`,
      kind: 'asset',
      source: c.sha,
    });
  }
}

// ---- 4. asset→code references + orphans ------------------------------------------------------
function mineReferences(repo, assets, codeFiles, out) {
  // engine sidecars (.meta) reference by design; exclude them as "assets to track" here
  const tracked = assets.filter((a) => a.cls !== 'engine')
    .sort((a, b) => b.size - a.size).slice(0, CAPS.refAssets);
  if (!tracked.length) return;
  const refCount = new Map(); // rel -> number of code files mentioning its basename
  for (const a of tracked) refCount.set(a.rel, 0);
  for (const cf of codeFiles) {
    let src;
    try {
      if (fs.statSync(path.join(repo, cf)).size > CAPS.codeFileBytes) continue;
      src = fs.readFileSync(path.join(repo, cf), 'utf8');
    } catch { continue; }
    for (const a of tracked) {
      if (src.includes(a.base)) refCount.set(a.rel, refCount.get(a.rel) + 1);
    }
  }
  const referenced = [...refCount.entries()].filter(([, n]) => n > 0).sort((a, b) => b[1] - a[1]);
  if (referenced.length) {
    const top = referenced.slice(0, CAPS.referenced).map(([p, n]) => `${path.posix.basename(p)} (${n})`).join(', ');
    out.push({
      title: `Most-referenced assets: ${referenced.length} of ${tracked.length} referenced from code`,
      summary: `Asset basenames grepped through ${codeFiles.length} code/text files. Most referenced: ${top}. Heavily-referenced assets are load-bearing — renaming/replacing them is high-blast-radius. [top ${CAPS.referenced}; ${tracked.length} largest assets checked]`,
      kind: 'asset',
      source: 'asset-ref-scan',
    });
  }
  const orphansByClass = new Map();
  for (const a of tracked) {
    if (refCount.get(a.rel) === 0) {
      if (!orphansByClass.has(a.cls)) orphansByClass.set(a.cls, []);
      orphansByClass.get(a.cls).push(a);
    }
  }
  for (const [cls, list] of orphansByClass) {
    list.sort((a, b) => b.size - a.size);
    const shown = list.slice(0, CAPS.orphansPerClass);
    out.push({
      title: `Possible orphan assets: ${list.length} ${cls} file(s) never referenced in code`,
      summary: `No code/text file mentions these ${cls} basenames: ${shown.map((a) => a.rel).join(', ')}` +
        (list.length > shown.length ? ` … [list capped at ${CAPS.orphansPerClass} of ${list.length}]` : '') +
        `. Orphans may be dead weight OR loaded dynamically (path built at runtime, engine manifest) — verify before calling them unused.`,
      kind: 'asset',
      source: `asset-ref-scan:${cls}`,
    });
  }
}

function main() {
  const repo = arg('repo');
  if (!repo || !fs.existsSync(repo)) { console.error('usage: onboard-mine-assets.js --repo <abs> [--out <dir>]'); process.exit(2); }
  const repoAbs = path.resolve(repo);
  const outDir = path.resolve(arg('out', path.join(SELF_REPO, 'bench', 'onboard', path.basename(repoAbs))));
  const OUT = path.join(outDir, 'asset-notes.json');

  const assets = [];
  const codeFiles = [];
  walk(repoAbs, repoAbs, assets, codeFiles);

  const out = [];
  mineInventory(assets, out);
  mineOutliers(repoAbs, assets, out);
  mineChurn(repoAbs, out);
  mineReferences(repoAbs, assets, codeFiles, out);

  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(out, null, 2) + '\n');
  console.log(`wrote ${OUT}`);
  console.log(`repo=${repoAbs} assets=${assets.length} codeFiles=${codeFiles.length} candidates=${out.length} sips=${sipsAvailable() ? 'yes' : 'no'}`);
  for (const c of out.slice(0, 12)) console.log(`  [${c.kind}] ${c.title}`);
}

main();
