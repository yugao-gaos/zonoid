'use strict';
// code-extract/backends/treesitter.js — multi-language backend via web-tree-sitter (WASM grammars).
//
// One backend that handles EVERY non-JS/TS language, behind the same contract as babel.js:
//   extractFile(relPath, source, ext) -> { symbols, edges }
//
// Why web-tree-sitter (WASM) and NOT native tree-sitter: the WASM build needs no node-gyp / per-
// platform native compile, so it is portable across Windows/mac/Linux and survives the empty
// worktree node_modules we run in. Grammars are the prebuilt .wasm files vendored by the
// `tree-sitter-wasms` npm package (one .wasm per language); the runtime is `web-tree-sitter`.
//
// ── ASYNC INIT, SYNC EXTRACT ────────────────────────────────────────────────────────────────────
// web-tree-sitter's Parser.init() and Language.load() are async (they instantiate WASM). extractRepo
// is synchronous (and the Phase-1 JS/TS test drives it synchronously), so we split the two phases:
//   • initTreeSitter()  — async, ONE-TIME: boots the WASM runtime + loads all 6 grammars. Callers
//                         that want non-JS/TS extraction await this before extractRepo.
//   • extractFile(...)  — synchronous: parse + extract. Throws if init() has not completed, so a
//                         caller can never silently get empty results from an uninitialised backend.
// The babel (JS/TS) path needs no init at all, so the Phase-1 path stays fully synchronous/untouched.
//
// ── EXTRACTION STRATEGY ─────────────────────────────────────────────────────────────────────────
// Per language we run ONE tree-sitter query (.scm string) capturing the top-level declaration nodes
// (functions / classes / structs / interfaces / enums / methods) plus call callees and import
// specifiers. Names mostly come from a `name:` field; C/C++ have no name field on functions (the name
// is buried in the declarator), so those use a tiny declarator descent. Output is mapped to the SAME
// shape babel emits.
//
// ── PER-LANGUAGE KIND MAPPING (documented; also surfaced in the task summary) ────────────────────
//   Python : def -> function, def-inside-class -> method, class -> class
//   Go     : func -> function, method (func (recv) ) -> method, type X struct -> struct,
//            type X interface -> interface, interface method spec -> method
//   Rust   : fn -> function, fn-inside-impl/trait -> method, struct -> struct, enum -> enum,
//            trait -> interface  (closest existing kind for a Rust trait)
//   Java   : method -> method, top-level/standalone -> function (none in idiomatic Java),
//            class -> class, interface -> interface, enum -> enum
//   C      : function -> function, struct -> struct, enum -> enum
//   C++    : free function -> function, member function -> method, class -> class, struct -> struct,
//            enum -> enum
// `struct`, `interface`, and `enum` are NEW kinds added beyond the JS set (function/class/method/
// arrow) — natural fits the code-index layer already consumes uniformly (it never special-cases kind).

const fs = require('fs');
const path = require('path');

// web-tree-sitter exports a single Parser constructor (0.20.x API): Parser.init(), Parser.Language.
const Parser = require('web-tree-sitter');

// Resolve a vendored grammar .wasm. Prefer a repo-local vendor dir (lib/code-extract/grammars) so the
// extractor is self-contained when published; fall back to the tree-sitter-wasms package's out/ dir
// (present in dev / node_modules). First existing path wins.
function grammarPath(wasmBase) {
  const file = `tree-sitter-${wasmBase}.wasm`;
  const candidates = [
    path.join(__dirname, '..', 'grammars', file), // vendored (publishable)
    // tree-sitter-wasms package layout: <pkg>/out/tree-sitter-<lang>.wasm
    safeResolvePkgWasm(file),
  ].filter(Boolean);
  for (const c of candidates) {
    try { if (fs.statSync(c).isFile()) return c; } catch { /* keep trying */ }
  }
  return null;
}

function safeResolvePkgWasm(file) {
  try {
    const pkgJson = require.resolve('tree-sitter-wasms/package.json');
    return path.join(path.dirname(pkgJson), 'out', file);
  } catch {
    return null;
  }
}

// Language table: ext(s) -> { lang, wasm, query-builder }. One entry per supported language. Adding a
// language is purely additive here (a wasm + a query) — index.js/registry dispatch never change.
const LANGUAGES = {
  python: { wasm: 'python', exts: ['.py'] },
  go: { wasm: 'go', exts: ['.go'] },
  rust: { wasm: 'rust', exts: ['.rs'] },
  java: { wasm: 'java', exts: ['.java'] },
  c: { wasm: 'c', exts: ['.c', '.h'] },
  cpp: { wasm: 'cpp', exts: ['.cpp', '.cc', '.cxx', '.hpp', '.hh', '.hxx'] },
};

// ext -> language key
const EXT_TO_LANG = (() => {
  const m = new Map();
  for (const [key, cfg] of Object.entries(LANGUAGES)) {
    for (const e of cfg.exts) m.set(e, key);
  }
  return m;
})();

// Lazily-populated after initTreeSitter(): langKey -> { language, parser }.
const loaded = new Map();
let initStarted = null; // the in-flight init promise (so concurrent callers share one boot)
let ready = false;

// Boot the WASM runtime and load every available grammar. Idempotent + concurrency-safe. Grammars
// that fail to load are skipped (recorded in the returned report) rather than aborting the whole init,
// so a single missing/broken .wasm degrades that one language instead of killing all of them.
async function initTreeSitter() {
  if (ready) return { ready: true, languages: [...loaded.keys()], skipped: [] };
  if (initStarted) return initStarted;
  initStarted = (async () => {
    const skipped = [];
    await Parser.init();
    for (const [key, cfg] of Object.entries(LANGUAGES)) {
      const wasm = grammarPath(cfg.wasm);
      if (!wasm) { skipped.push({ language: key, reason: 'grammar .wasm not found' }); continue; }
      try {
        const language = await Parser.Language.load(wasm);
        const parser = new Parser();
        parser.setLanguage(language);
        loaded.set(key, { language, parser });
      } catch (e) {
        skipped.push({ language: key, reason: String(e && e.message || e) });
      }
    }
    ready = true;
    return { ready: true, languages: [...loaded.keys()], skipped };
  })();
  return initStarted;
}

function isInitialized() { return ready; }
function supportedExtensions() { return [...EXT_TO_LANG.keys()]; }

// ── extraction ───────────────────────────────────────────────────────────────────────────────────

function extractFile(relPath, source, ext) {
  if (!ready) {
    throw new Error('treesitter backend not initialized — await initTreeSitter() before extractRepo for non-JS/TS files');
  }
  const langKey = EXT_TO_LANG.get(String(ext || '').toLowerCase());
  if (!langKey) return null; // not a tree-sitter language we handle
  const entry = loaded.get(langKey);
  if (!entry) return null; // grammar failed to load at init — treated as parse_failed by caller

  let tree;
  try {
    tree = entry.parser.parse(source);
  } catch {
    return null;
  }
  const root = tree && tree.rootNode;
  if (!root) return null;

  const handler = HANDLERS[langKey];
  const symbols = [];
  const edges = [];
  handler(root, relPath, source, symbols, edges);
  return { symbols, edges };
}

// ── shared AST helpers (web-tree-sitter Node API) ─────────────────────────────────────────────────

const sLine = (n) => (n ? n.startPosition.row + 1 : null);
const eLine = (n) => (n ? n.endPosition.row + 1 : null);

// One-line signature: the node's own source first line, whitespace-collapsed, capped. Tree-sitter
// gives us exact spans, so "the declaration's first line" is a faithful, language-neutral signature
// without re-implementing each language's grammar for parameter rendering.
function firstLineSig(node, maxLen = 160) {
  if (!node) return '';
  const text = node.text || '';
  const firstLine = text.split('\n')[0].replace(/\s+/g, ' ').trim();
  // strip a trailing opening brace so signatures read cleanly (e.g. "func Add(a int, b int) int")
  const cleaned = firstLine.replace(/\s*\{$/, '').trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen - 3) + '...' : cleaned;
}

function nameField(node) {
  const n = node.childForFieldName && node.childForFieldName('name');
  return n ? n.text : null;
}

// Collect every call callee identifier in the subtree as a 'calls' edge. Call nodes differ per
// grammar: `call_expression` (Go/Rust/C/C++) and `call` (Python) carry the callee in a `function`
// field; Java's `method_invocation` carries the invoked identifier in a `name` field (with the
// receiver in `object`). In all cases we take the TRAILING identifier (so `pkg.Fn()` / `obj.method()`
// -> the invoked name), matching babel's a.b.c() -> c.
function collectCalls(root, relPath, edges) {
  const seen = new Set();
  walk(root, (n) => {
    let callee = null;
    if (n.type === 'call_expression' || n.type === 'call') {
      callee = trailingIdentifier(n.childForFieldName('function') || n.childForFieldName('callee'));
    } else if (n.type === 'method_invocation') {
      // Java: prefer the explicit `name` field; fall back to trailing-id of the whole node.
      const nm = n.childForFieldName('name');
      callee = nm ? nm.text : trailingIdentifier(n);
    }
    if (callee && !seen.has(callee)) { seen.add(callee); edges.push({ from: relPath, to: callee, kind: 'calls' }); }
  });
}

// Walk down the right edge of a callee expression to the actual invoked identifier name.
// foo -> foo ; pkg.Fn -> Fn ; a.b.c -> c ; obj->method (C++) -> method ; generic/qualified -> last id.
function trailingIdentifier(node) {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
    case 'field_identifier':
    case 'type_identifier':
    case 'package_identifier':
      return node.text;
    case 'selector_expression': // Go pkg.Fn
    case 'field_expression':     // C/C++ a.b / a->b
    case 'attribute':            // Python a.b
    case 'scoped_identifier':    // Rust/C++ a::b
    case 'member_expression': {
      const f = node.childForFieldName('field') || node.childForFieldName('name')
        || node.childForFieldName('attribute') || node.childForFieldName('property');
      if (f) return f.text;
      // fall back to the last named child identifier
      return lastIdentifierChild(node);
    }
    case 'generic_function': // Rust foo::<T>
    case 'call_expression':
      return trailingIdentifier(node.childForFieldName('function') || lastNamedChild(node));
    default:
      return lastIdentifierChild(node);
  }
}

function lastIdentifierChild(node) {
  for (let i = node.namedChildCount - 1; i >= 0; i--) {
    const c = node.namedChild(i);
    if (/identifier/.test(c.type)) return c.text;
  }
  return null;
}
function lastNamedChild(node) {
  return node.namedChildCount ? node.namedChild(node.namedChildCount - 1) : null;
}

// Generic pre-order walk over NAMED nodes.
function walk(node, visit) {
  visit(node);
  for (let i = 0; i < node.namedChildCount; i++) walk(node.namedChild(i), visit);
}

// Push a symbol with the common stamp.
function pushSym(symbols, { name, kind, file, node, signature, exported = false, klass = null }) {
  if (!name) return;
  symbols.push({
    name,
    kind,
    file,
    start_line: sLine(node),
    end_line: eLine(node),
    signature: signature != null ? signature : firstLineSig(node),
    exported: !!exported,
    ...(klass ? { class: klass } : {}),
  });
}

// ── C/C++ declarator name digging ─────────────────────────────────────────────────────────────────
// In C/C++ a function's name is not a `name` field — it's the innermost identifier under nested
// declarators: function_definition.declarator -> function_declarator.declarator -> identifier
// (possibly wrapped by pointer_declarator / reference_declarator / parenthesized_declarator, or a
// qualified/field/destructor identifier for C++ members).
function cFunctionName(fnDef) {
  let d = fnDef.childForFieldName('declarator');
  // descend through wrapping declarators to the function_declarator, then to its declarator name.
  let guard = 0;
  while (d && guard++ < 12) {
    if (d.type === 'function_declarator') {
      const inner = d.childForFieldName('declarator');
      return declaratorIdentifier(inner);
    }
    if (d.childForFieldName && d.childForFieldName('declarator')) {
      d = d.childForFieldName('declarator');
      continue;
    }
    break;
  }
  return declaratorIdentifier(d);
}

function declaratorIdentifier(node) {
  if (!node) return null;
  switch (node.type) {
    case 'identifier':
    case 'field_identifier':
    case 'type_identifier':
      return node.text;
    case 'qualified_identifier': // C++ ns::Class::method
    case 'scoped_identifier':
    case 'destructor_name':
    case 'operator_name':
      return node.text;
    default:
      return declaratorIdentifier(node.childForFieldName && node.childForFieldName('declarator'))
        || lastIdentifierChild(node);
  }
}

// ── import collectors ──────────────────────────────────────────────────────────────────────────────
// All import edges from tree-sitter are EXTERNAL by default (cross-language local-module resolution is
// out of scope for Phase-1b; resolveModule in walk.js is JS-specific). We still emit them so the graph
// records dependency direction; `external:true` marks them as unresolved specifiers.
function importEdge(relPath, spec) {
  const s = String(spec || '').replace(/^["'<]|["'>]$/g, '').trim();
  if (!s) return null;
  return { from: relPath, to: s, kind: 'imports', external: true };
}

// ── per-language handlers ──────────────────────────────────────────────────────────────────────────

const HANDLERS = {
  // PYTHON ----------------------------------------------------------------------------------------
  python(root, file, src, symbols, edges) {
    for (let i = 0; i < root.namedChildCount; i++) {
      const n = root.namedChild(i);
      if (n.type === 'function_definition') {
        pushSym(symbols, { name: nameField(n), kind: 'function', file, node: n });
      } else if (n.type === 'decorated_definition') {
        const def = n.childForFieldName('definition') || lastNamedChild(n);
        if (def && def.type === 'function_definition') pushSym(symbols, { name: nameField(def), kind: 'function', file, node: def });
        else if (def && def.type === 'class_definition') pythonClass(def, file, symbols);
      } else if (n.type === 'class_definition') {
        pythonClass(n, file, symbols);
      } else if (n.type === 'import_statement' || n.type === 'import_from_statement') {
        for (const spec of pythonImportSpecs(n)) { const e = importEdge(file, spec); if (e) edges.push(e); }
      }
    }
    collectCalls(root, file, edges);
  },

  // GO --------------------------------------------------------------------------------------------
  go(root, file, src, symbols, edges) {
    walk(root, (n) => {
      if (n.type === 'function_declaration') {
        pushSym(symbols, { name: nameField(n), kind: 'function', file, node: n, exported: goExported(nameField(n)) });
      } else if (n.type === 'method_declaration') {
        pushSym(symbols, { name: nameField(n), kind: 'method', file, node: n, exported: goExported(nameField(n)) });
      } else if (n.type === 'type_spec') {
        const nm = nameField(n);
        const t = n.childForFieldName('type');
        const kind = t && t.type === 'struct_type' ? 'struct' : t && t.type === 'interface_type' ? 'interface' : 'type';
        if (kind !== 'type') pushSym(symbols, { name: nm, kind, file, node: n, exported: goExported(nm), signature: firstLineSig(n) });
        // interface method specs -> methods
        if (t && t.type === 'interface_type') {
          walk(t, (m) => { if (m.type === 'method_spec' || m.type === 'method_elem') pushSym(symbols, { name: nameField(m), kind: 'method', file, node: m, klass: nm, exported: goExported(nameField(m)) }); });
        }
      } else if (n.type === 'import_spec') {
        const p = n.childForFieldName('path');
        const e = importEdge(file, p ? p.text : null); if (e) edges.push(e);
      }
    });
    collectCalls(root, file, edges);
  },

  // RUST ------------------------------------------------------------------------------------------
  rust(root, file, src, symbols, edges) {
    walk(root, (n) => {
      if (n.type === 'function_item') {
        pushSym(symbols, { name: nameField(n), kind: 'function', file, node: n, exported: rustExported(n) });
      } else if (n.type === 'function_signature_item') {
        pushSym(symbols, { name: nameField(n), kind: 'method', file, node: n });
      } else if (n.type === 'struct_item') {
        pushSym(symbols, { name: nameField(n), kind: 'struct', file, node: n, exported: rustExported(n), signature: firstLineSig(n) });
      } else if (n.type === 'enum_item') {
        pushSym(symbols, { name: nameField(n), kind: 'enum', file, node: n, exported: rustExported(n), signature: firstLineSig(n) });
      } else if (n.type === 'trait_item') {
        pushSym(symbols, { name: nameField(n), kind: 'interface', file, node: n, exported: rustExported(n), signature: firstLineSig(n) });
      } else if (n.type === 'use_declaration') {
        const e = importEdge(file, rustUsePath(n)); if (e) edges.push(e);
      }
    });
    collectCalls(root, file, edges);
  },

  // JAVA ------------------------------------------------------------------------------------------
  java(root, file, src, symbols, edges) {
    walk(root, (n) => {
      if (n.type === 'method_declaration' || n.type === 'constructor_declaration') {
        const klass = enclosingTypeName(n);
        pushSym(symbols, { name: nameField(n), kind: 'method', file, node: n, klass, exported: javaPublic(n) });
      } else if (n.type === 'class_declaration') {
        pushSym(symbols, { name: nameField(n), kind: 'class', file, node: n, exported: javaPublic(n), signature: firstLineSig(n) });
      } else if (n.type === 'interface_declaration') {
        pushSym(symbols, { name: nameField(n), kind: 'interface', file, node: n, exported: javaPublic(n), signature: firstLineSig(n) });
      } else if (n.type === 'enum_declaration') {
        pushSym(symbols, { name: nameField(n), kind: 'enum', file, node: n, exported: javaPublic(n), signature: firstLineSig(n) });
      } else if (n.type === 'import_declaration') {
        const e = importEdge(file, javaImportName(n)); if (e) edges.push(e);
      }
    });
    collectCalls(root, file, edges);
  },

  // C ---------------------------------------------------------------------------------------------
  c(root, file, src, symbols, edges) {
    walk(root, (n) => {
      if (n.type === 'function_definition') {
        pushSym(symbols, { name: cFunctionName(n), kind: 'function', file, node: n, exported: true, signature: cFunctionSig(n) });
      } else if (n.type === 'struct_specifier' && nameField(n) && n.childForFieldName('body')) {
        pushSym(symbols, { name: nameField(n), kind: 'struct', file, node: n, exported: true, signature: firstLineSig(n) });
      } else if (n.type === 'enum_specifier' && nameField(n) && n.childForFieldName('body')) {
        pushSym(symbols, { name: nameField(n), kind: 'enum', file, node: n, exported: true, signature: firstLineSig(n) });
      } else if (n.type === 'preproc_include') {
        const p = n.childForFieldName('path');
        const e = importEdge(file, p ? p.text : null); if (e) edges.push(e);
      }
    });
    collectCalls(root, file, edges);
  },

  // C++ -------------------------------------------------------------------------------------------
  cpp(root, file, src, symbols, edges) {
    walk(root, (n) => {
      if (n.type === 'function_definition') {
        const name = cFunctionName(n);
        // member function if it sits inside a class/struct body
        const klass = enclosingCppTypeName(n);
        pushSym(symbols, { name, kind: klass ? 'method' : 'function', file, node: n, klass, exported: true, signature: cFunctionSig(n) });
      } else if ((n.type === 'class_specifier') && nameField(n) && n.childForFieldName('body')) {
        pushSym(symbols, { name: nameField(n), kind: 'class', file, node: n, exported: true, signature: firstLineSig(n) });
      } else if ((n.type === 'struct_specifier') && nameField(n) && n.childForFieldName('body')) {
        pushSym(symbols, { name: nameField(n), kind: 'struct', file, node: n, exported: true, signature: firstLineSig(n) });
      } else if (n.type === 'enum_specifier' && nameField(n) && n.childForFieldName('body')) {
        pushSym(symbols, { name: nameField(n), kind: 'enum', file, node: n, exported: true, signature: firstLineSig(n) });
      } else if (n.type === 'preproc_include') {
        const p = n.childForFieldName('path');
        const e = importEdge(file, p ? p.text : null); if (e) edges.push(e);
      }
    });
    collectCalls(root, file, edges);
  },
};

// ── per-language small helpers ─────────────────────────────────────────────────────────────────────

function pythonClass(classNode, file, symbols) {
  const cname = nameField(classNode);
  pushSym(symbols, { name: cname, kind: 'class', file, node: classNode, signature: firstLineSig(classNode) });
  const body = classNode.childForFieldName('body');
  if (!body) return;
  for (let i = 0; i < body.namedChildCount; i++) {
    let m = body.namedChild(i);
    if (m.type === 'decorated_definition') m = m.childForFieldName('definition') || lastNamedChild(m);
    if (m && m.type === 'function_definition') {
      pushSym(symbols, { name: nameField(m), kind: 'method', file, node: m, klass: cname });
    }
  }
}

function pythonImportSpecs(node) {
  const out = [];
  if (node.type === 'import_statement') {
    // import a, b.c as d -> dotted_name / aliased_import
    for (let i = 0; i < node.namedChildCount; i++) {
      const c = node.namedChild(i);
      if (c.type === 'dotted_name') out.push(c.text);
      else if (c.type === 'aliased_import') { const nm = c.childForFieldName('name'); if (nm) out.push(nm.text); }
    }
  } else if (node.type === 'import_from_statement') {
    const mod = node.childForFieldName('module_name');
    if (mod) out.push(mod.text);
  }
  return out;
}

const goExported = (name) => !!(name && /^[A-Z]/.test(name)); // Go: capitalized identifiers are exported
function rustExported(node) {
  // a `visibility_modifier` (pub) child marks the item public
  for (let i = 0; i < node.namedChildCount; i++) if (node.namedChild(i).type === 'visibility_modifier') return true;
  // also check the first non-named child token range cheaply via text prefix
  return /^\s*pub\b/.test(node.text || '');
}
function rustUsePath(node) {
  // use a::b::c;  -> take the argument text minus the leading `use ` and trailing `;`
  const t = (node.text || '').replace(/^use\s+/, '').replace(/;\s*$/, '').trim();
  return t || null;
}
function javaPublic(node) {
  const mods = node.namedChildren ? node.namedChildren.find((c) => c.type === 'modifiers') : null;
  if (mods && /\bpublic\b/.test(mods.text)) return true;
  // fallback scan of the leading text
  return /\bpublic\b/.test((node.text || '').slice(0, 40));
}
function javaImportName(node) {
  const t = (node.text || '').replace(/^import\s+(static\s+)?/, '').replace(/;\s*$/, '').trim();
  return t || null;
}

function cFunctionSig(fnDef) {
  // signature = return type + declarator (everything before the body block)
  const body = fnDef.childForFieldName('body');
  let text = fnDef.text || '';
  if (body) {
    const idx = text.indexOf(body.text);
    if (idx > 0) text = text.slice(0, idx);
  }
  return text.replace(/\s+/g, ' ').trim().replace(/\s*\{?$/, '');
}

// Climb ancestors to find the enclosing class/interface/enum name (Java).
function enclosingTypeName(node) {
  let p = node.parent;
  while (p) {
    if (p.type === 'class_declaration' || p.type === 'interface_declaration' || p.type === 'enum_declaration') {
      return nameField(p);
    }
    p = p.parent;
  }
  return null;
}

// Climb ancestors to find an enclosing C++ class/struct name (so member functions get a class).
function enclosingCppTypeName(node) {
  let p = node.parent;
  while (p) {
    if (p.type === 'class_specifier' || p.type === 'struct_specifier') return nameField(p);
    // stop at translation unit / namespace — a free function under a namespace has no class
    if (p.type === 'translation_unit') break;
    p = p.parent;
  }
  return null;
}

module.exports = {
  extractFile,
  initTreeSitter,
  isInitialized,
  supportedExtensions,
  LANGUAGES,
  EXT_TO_LANG,
};
