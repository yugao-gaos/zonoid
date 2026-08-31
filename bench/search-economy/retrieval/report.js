'use strict';

// Regenerate the combined cross-arm comparison from results.jsonl.
//
//   node bench/search-economy/retrieval/run.js      # produce results.jsonl
//   node bench/search-economy/retrieval/report.js   # render REPORT-phase1b.md
//
// The report is GENERATED, never hand-edited: a hand-copied results table silently rots
// the moment an arm changes. Prose that is not derivable from results.jsonl lives in
// README.md instead.

const fs = require('fs');
const path = require('path');

const HERE = __dirname;
const RESULTS_PATH = path.join(HERE, 'results.jsonl');
const CORPUS_PATH = path.join(HERE, 'corpus.json');
const REPORT_PATH = path.join(HERE, '..', 'REPORT-phase1b.md');

// Arm display order: baseline first, then the substrates under test.
const ARM_ORDER = ['naive', 'subconscious', 'codebase-memory'];

function loadRows() {
  if (!fs.existsSync(RESULTS_PATH)) {
    throw new Error(`no results.jsonl at ${RESULTS_PATH} — run run.js first`);
  }
  return fs.readFileSync(RESULTS_PATH, 'utf8')
    .split('\n').map((s) => s.trim()).filter(Boolean)
    .map((line) => JSON.parse(line));
}

function orderArms(arms) {
  const known = ARM_ORDER.filter((a) => arms.includes(a));
  const rest = arms.filter((a) => !ARM_ORDER.includes(a)).sort();
  return [...known, ...rest];
}

function fmt(n, digits = 3) {
  if (n == null || !Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function summarize(rows, arm) {
  const rs = rows.filter((r) => r.arm === arm);
  const totalTokens = rs.reduce((s, r) => s + (r.tokens || 0), 0);
  const totalCorrect = rs.reduce((s, r) => s + (r.correct || 0), 0);
  const totalRelevant = rs.reduce((s, r) => s + (r.n_relevant || 0), 0);
  const meanTokens = rs.length ? totalTokens / rs.length : 0;
  const meanRecall = rs.length ? rs.reduce((s, r) => s + (r.recall || 0), 0) / rs.length : 0;
  return {
    arm,
    n: rs.length,
    totalTokens,
    totalCorrect,
    totalRelevant,
    meanTokens,
    meanRecall,
    perfect: rs.filter((r) => r.n_relevant && r.correct === r.n_relevant).length,
    zero: rs.filter((r) => !r.correct).length,
    pooled: totalCorrect > 0 ? totalTokens / totalCorrect : null,
  };
}

function mdTable(header, alignRight, bodyRows) {
  const sep = header.map((_, i) => (alignRight[i] ? '---:' : ':---'));
  return [
    `| ${header.join(' | ')} |`,
    `| ${sep.join(' | ')} |`,
    ...bodyRows.map((r) => `| ${r.join(' | ')} |`),
  ].join('\n');
}

function main() {
  const rows = loadRows();
  const corpus = JSON.parse(fs.readFileSync(CORPUS_PATH, 'utf8'));
  const arms = orderArms([...new Set(rows.map((r) => r.arm))]);
  const summaries = arms.map((a) => summarize(rows, a));

  const byId = new Map();
  for (const r of rows) {
    if (!byId.has(r.id)) byId.set(r.id, {});
    byId.get(r.id)[r.arm] = r;
  }
  const ids = [...byId.keys()].sort();

  const best = summaries
    .filter((s) => s.pooled != null)
    .sort((a, b) => a.pooled - b.pooled)[0];
  const baseline = summaries.find((s) => s.arm === 'naive');

  const out = [];
  out.push('# Search-economy retrieval bench — Phase 1b combined comparison');
  out.push('');
  out.push('**Generated** by `node bench/search-economy/retrieval/report.js` from');
  out.push('`retrieval/results.jsonl`. Do not hand-edit — re-run `run.js` then `report.js`.');
  out.push('');
  out.push(`Corpus: **${corpus.queries.length} code-navigation queries** over the zonoid repo`);
  out.push(`(\`corpus.json\` v${corpus.version}). Arms: **${arms.length}** live.`);
  out.push('');
  out.push('The question: for the same code-nav query, how many context tokens does each');
  out.push('retrieval substrate spend, and how much of the ground-truth answer does that');
  out.push('context actually contain? Headline is **pooled tokens-per-correct-symbol**.');
  out.push('');

  // ---- Headline ----
  out.push('## Headline');
  out.push('');
  out.push(mdTable(
    ['arm', 'n', 'mean tokens', 'mean recall', 'perfect', 'zero-recall', 'correct/total', 'POOLED tok/correct'],
    [false, true, true, true, true, true, true, true],
    summaries.map((s) => [
      `\`${s.arm}\``,
      s.n,
      fmt(s.meanTokens, 1),
      fmt(s.meanRecall),
      `${s.perfect}/${s.n}`,
      `${s.zero}/${s.n}`,
      `${s.totalCorrect}/${s.totalRelevant}`,
      s.pooled == null ? '—' : fmt(s.pooled, 1),
    ])
  ));
  out.push('');
  if (best && baseline && baseline.pooled != null && best.arm !== 'naive') {
    const ratio = baseline.pooled / best.pooled;
    const tokenShare = baseline.totalTokens ? (best.totalTokens / baseline.totalTokens) * 100 : 0;
    out.push(`**Winner: \`${best.arm}\`** — ${fmt(ratio, 2)}x better token economy than the`);
    out.push(`\`naive\` grep baseline (${fmt(best.pooled, 1)} vs ${fmt(baseline.pooled, 1)} tokens per`);
    out.push(`correct symbol), while spending only ${fmt(tokenShare, 0)}% of naive's total tokens and`);
    out.push(`recovering ${best.totalCorrect} ground-truth symbols to naive's ${baseline.totalCorrect}.`);
    out.push('');
  }
  out.push('> **Why pooled, not the per-query mean.** A per-query `tokens/correct` mean can only');
  out.push('> be averaged over queries that scored at least one correct symbol, so an arm that');
  out.push('> fails a query outright has its most expensive failure *excluded* from its own');
  out.push('> average. Pooling (`sum(tokens) / sum(correct)`) charges every query. `run.js`');
  out.push('> prints both; this report leads with the pooled figure.');
  out.push('');

  // ---- Per-query ----
  out.push('## Per-query detail');
  out.push('');
  out.push('Each cell is `tokens` / `correct-of-relevant`. Bold = every ground-truth symbol found.');
  out.push('');
  out.push(mdTable(
    ['query', 'intent', ...arms.map((a) => `\`${a}\``)],
    [false, false, ...arms.map(() => true)],
    ids.map((id) => {
      const group = byId.get(id);
      const spec = corpus.queries.find((q) => q.id === id) || {};
      const cells = arms.map((a) => {
        const r = group[a];
        if (!r) return '—';
        const body = `${r.tokens}t · ${r.correct}/${r.n_relevant}`;
        return (r.n_relevant && r.correct === r.n_relevant) ? `**${body}**` : body;
      });
      return [id, (spec.intent || '').split(':')[0], ...cells];
    })
  ));
  out.push('');

  // ---- Where each arm fails ----
  out.push('## Where each arm loses');
  out.push('');
  for (const arm of arms) {
    const misses = rows.filter((r) => r.arm === arm && !r.correct).map((r) => r.id);
    out.push(`- \`${arm}\` — zero-recall on ${misses.length ? misses.join(', ') : '(none)'}`);
  }
  out.push('');

  fs.writeFileSync(REPORT_PATH, out.join('\n') + '\n');
  console.log(`Wrote ${path.relative(process.cwd(), REPORT_PATH).replace(/\\/g, '/')}`);
  for (const s of summaries) {
    console.log(`  ${s.arm.padEnd(16)} pooled tok/correct = ${fmt(s.pooled, 1)}  (${s.totalCorrect}/${s.totalRelevant} symbols)`);
  }
}

main();
