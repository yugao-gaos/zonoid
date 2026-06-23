'use strict';
// code-extract/parse.js — thin @babel/parser wrapper with extension-driven plugin selection.
//
// One place that decides "given a .ts/.tsx/.jsx/.js file, which babel plugins to enable". Parses in
// module sourceType with errorRecovery so a single malformed construct degrades to a partial AST
// instead of throwing; a hard failure returns null and the caller skips that file (the extractor
// must be robust across a whole repo, not abort on one unparseable file).

const babel = require('@babel/parser');

// Plugins enabled for every file. typescript + jsx cannot BOTH be combined with the `flow` plugin,
// and .ts (non-tsx) disallows jsx, so we branch on extension below for those two.
const COMMON_PLUGINS = [
  'classProperties',
  'classPrivateProperties',
  'classPrivateMethods',
  'classStaticBlock',
  'decorators-legacy',
  'objectRestSpread',
  'optionalChaining',
  'nullishCoalescingOperator',
  'numericSeparator',
  'logicalAssignment',
  'topLevelAwait',
  'importAssertions',
  'dynamicImport',
  'exportDefaultFrom',
  'exportNamespaceFrom',
];

function pluginsForExt(ext) {
  const e = String(ext || '').toLowerCase();
  if (e === '.ts') return ['typescript', ...COMMON_PLUGINS]; // .ts: TS, no JSX (`<T>` is a cast)
  if (e === '.tsx') return ['typescript', 'jsx', ...COMMON_PLUGINS];
  // .js/.mjs/.cjs/.jsx — enable JSX (common in .js React) but not TS.
  return ['jsx', ...COMMON_PLUGINS];
}

// Parse source for a given file extension. Returns the babel File AST, or null on a hard failure.
function parseSource(src, ext) {
  try {
    return babel.parse(src, {
      sourceType: 'module',
      allowReturnOutsideFunction: true,
      allowImportExportEverywhere: true,
      errorRecovery: true,
      plugins: pluginsForExt(ext),
    });
  } catch {
    return null;
  }
}

module.exports = { parseSource, pluginsForExt, COMMON_PLUGINS };
