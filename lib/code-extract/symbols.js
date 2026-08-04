'use strict';
// code-extract/symbols.js — walk a babel File AST and extract symbols + call/import edges.
//
// Deliberately dependency-light: a hand-rolled recursive descent over the AST instead of
// @babel/traverse, so the extractor pulls in only @babel/parser (smaller install, deterministic,
// no scope/binding machinery we don't need). For each parsed file it yields:
//   symbols[] — { name, kind:'function'|'class'|'method'|'arrow', start_line, end_line,
//                 signature, exported }
//   imports[] — local+package module specifiers (string)
//   calls[]   — callee identifier names invoked anywhere in the file
//
// "calls" are collected per-file (not per-symbol) at this layer; the extractor (index.js) attaches
// them to the enclosing file node. Callee resolution to a specific symbol is a later phase — here we
// only record the raw callee name, which is what the code-index layer consumes.

// ---- small AST helpers -------------------------------------------------------

function startLine(node) { return node && node.loc ? node.loc.start.line : null; }
function endLine(node) { return node && node.loc ? node.loc.end.line : null; }

// Render a parameter list back to a compact signature string. We slice the params' source span when
// available; otherwise fall back to a best-effort name list. Default values / destructuring / TS
// type annotations are preserved when we can read them from `code`.
function paramsSignature(node, code) {
  const params = node && node.params ? node.params : [];
  if (!params.length) return '()';
  if (code && params[0].start != null && params[params.length - 1].end != null) {
    const from = params[0].start;
    const to = params[params.length - 1].end;
    const raw = code.slice(from, to).replace(/\s+/g, ' ').trim();
    return '(' + raw + ')';
  }
  // Fallback: identifier names only.
  const names = params.map((p) => paramName(p)).filter(Boolean);
  return '(' + names.join(', ') + ')';
}

function paramName(p) {
  if (!p) return '';
  switch (p.type) {
    case 'Identifier': return p.name;
    case 'AssignmentPattern': return paramName(p.left);
    case 'RestElement': return '...' + paramName(p.argument);
    case 'ObjectPattern': return '{…}';
    case 'ArrayPattern': return '[…]';
    case 'TSParameterProperty': return paramName(p.parameter);
    default: return p.name || '';
  }
}

// Is this declaration exported? We mark a symbol exported if its declaration node sits directly
// under an ExportNamedDeclaration / ExportDefaultDeclaration (tracked via the `exported` flag we
// thread through the walk), or if a later `export { name }` references it. The walk handles the
// direct case; trailing named-export specifiers are reconciled in extractFromAst.

// Build a function-ish signature: `name(params)` (+ ` => …` marker for arrows handled by caller).
function fnSignature(name, node, code) {
  const asyncPrefix = node.async ? 'async ' : '';
  const genStar = node.generator ? '*' : '';
  return `${asyncPrefix}${genStar}${name}${paramsSignature(node, code)}`;
}

// ---- call-name collection ----------------------------------------------------

// Recursively collect callee identifier names from any subtree. For `foo()` → "foo"; for
// `a.b.c()` → "c" (the property actually invoked); computed member calls are skipped. Deterministic
// order (source order via recursion); de-dup is the caller's job.
function collectCallNames(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) collectCallNames(c, out); return; }
  if (node.type === 'CallExpression' || node.type === 'OptionalCallExpression') {
    const name = calleeName(node.callee);
    if (name) out.push(name);
  } else if (node.type === 'NewExpression') {
    const name = calleeName(node.callee);
    if (name) out.push(name);
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' ||
        key === 'trailingComments' || key === 'innerComments' || key === 'range') continue;
    const v = node[key];
    if (v && typeof v === 'object') collectCallNames(v, out);
  }
}

function calleeName(callee) {
  if (!callee) return null;
  if (callee.type === 'Identifier') return callee.name;
  if (callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression') {
    if (!callee.computed && callee.property && callee.property.type === 'Identifier') {
      return callee.property.name;
    }
    return null;
  }
  if (callee.type === 'V8IntrinsicIdentifier') return callee.name;
  return null;
}

// ---- CommonJS require() collection ------------------------------------------

// Collect string specifiers from `require('x')` calls anywhere in the subtree. The repo is largely
// CommonJS, so import edges must include require() — not just ESM `import` — to match the structure
// miner (SPEC_RE) and keep import edges meaningful.
function collectRequireSpecs(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) collectRequireSpecs(c, out); return; }
  if ((node.type === 'CallExpression' || node.type === 'OptionalCallExpression') &&
      node.callee && node.callee.type === 'Identifier' && node.callee.name === 'require' &&
      Array.isArray(node.arguments) && node.arguments.length &&
      node.arguments[0].type === 'StringLiteral') {
    out.push(node.arguments[0].value);
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' ||
        key === 'trailingComments' || key === 'innerComments' || key === 'range') continue;
    const v = node[key];
    if (v && typeof v === 'object') collectRequireSpecs(v, out);
  }
}

// ---- CommonJS export-name collection ----------------------------------------

// Collect names exported via CommonJS: `module.exports = { a, b }`, `module.exports.foo = ...`,
// and `exports.foo = ...`. Walks the whole program (top-level + conditional re-exports). Names are
// reconciled against collected symbols so the `exported` flag is meaningful in CJS modules too.
function collectCjsExportNames(node, out) {
  if (!node || typeof node !== 'object') return;
  if (Array.isArray(node)) { for (const c of node) collectCjsExportNames(c, out); return; }
  if (node.type === 'AssignmentExpression' && node.operator === '=') {
    const left = node.left;
    // module.exports = { a, b, c } | module.exports = name
    if (isModuleExports(left)) {
      if (node.right && node.right.type === 'ObjectExpression') {
        for (const p of node.right.properties) {
          if ((p.type === 'ObjectProperty' || p.type === 'Property') && p.key) {
            if (p.key.type === 'Identifier') out.add(p.key.name);
            else if (p.key.type === 'StringLiteral') out.add(p.key.value);
          }
        }
      } else if (node.right && node.right.type === 'Identifier') {
        out.add(node.right.name);
      }
    } else if (isExportsMember(left)) {
      // module.exports.foo = ... | exports.foo = ...
      if (left.property) {
        if (left.property.type === 'Identifier') out.add(left.property.name);
        else if (left.property.type === 'StringLiteral') out.add(left.property.value);
      }
    }
  }
  for (const key of Object.keys(node)) {
    if (key === 'loc' || key === 'start' || key === 'end' || key === 'leadingComments' ||
        key === 'trailingComments' || key === 'innerComments' || key === 'range') continue;
    const v = node[key];
    if (v && typeof v === 'object') collectCjsExportNames(v, out);
  }
}

// `module.exports` member expression.
function isModuleExports(n) {
  return n && n.type === 'MemberExpression' && !n.computed &&
    n.object && n.object.type === 'Identifier' && n.object.name === 'module' &&
    n.property && n.property.type === 'Identifier' && n.property.name === 'exports';
}

// `exports.foo` or `module.exports.foo` (returns the FINAL member, whose .property is the name).
function isExportsMember(n) {
  if (!n || n.type !== 'MemberExpression' || n.computed) return false;
  // exports.foo
  if (n.object && n.object.type === 'Identifier' && n.object.name === 'exports') return true;
  // module.exports.foo
  if (n.object && isModuleExports(n.object)) return true;
  return false;
}

// ---- symbol extraction -------------------------------------------------------

// Determine whether an arrow/function-expression-bearing VariableDeclarator should be reported as a
// symbol, and with what kind. `const f = () => {}` → arrow; `const f = function(){}` → function.
function initFnKind(init) {
  if (!init) return null;
  if (init.type === 'ArrowFunctionExpression') return 'arrow';
  if (init.type === 'FunctionExpression') return 'function';
  return null;
}

// Walk class body and push method symbols. Each method's signature is `Class.method(params)`.
function extractClassMethods(classNode, className, code, symbols) {
  const body = classNode.body && classNode.body.body ? classNode.body.body : [];
  for (const m of body) {
    if (m.type !== 'ClassMethod' && m.type !== 'ClassPrivateMethod') continue;
    let mname;
    if (m.key && m.key.type === 'Identifier') mname = m.key.name;
    else if (m.key && m.key.type === 'PrivateName' && m.key.id) mname = '#' + m.key.id.name;
    else if (m.key && m.key.type === 'StringLiteral') mname = m.key.value;
    else mname = '<computed>';
    const kindPrefix = m.kind === 'get' ? 'get ' : m.kind === 'set' ? 'set ' : '';
    const staticPrefix = m.static ? 'static ' : '';
    const asyncPrefix = m.async ? 'async ' : '';
    const genStar = m.generator ? '*' : '';
    const sig = `${staticPrefix}${asyncPrefix}${kindPrefix}${genStar}${className}.${mname}${paramsSignature(m, code)}`;
    symbols.push({
      name: mname,
      kind: 'method',
      class: className,
      start_line: startLine(m),
      end_line: endLine(m),
      signature: sig,
      exported: false, // methods aren't independently exported; class export is tracked separately
    });
  }
}

// Core: walk the top-level program body (+ export wrappers) and extract symbols. We only descend
// into export declarations to discover top-level + class-member symbols — nested function
// expressions inside bodies are intentionally NOT reported as their own symbols (the deliverable is
// top-level declarations + class methods + named arrow/function consts).
function extractFromAst(ast, code) {
  const symbols = [];
  const imports = [];
  const exportedNames = new Set(); // names referenced by `export { a, b }`

  const body = ast && ast.program && ast.program.body ? ast.program.body : [];

  for (const node of body) {
    let decl = node;
    let exported = false;

    if (node.type === 'ExportNamedDeclaration') {
      // `export { a, b }` (no inline declaration) — record names for reconciliation.
      if (!node.declaration && Array.isArray(node.specifiers)) {
        for (const s of node.specifiers) {
          if (s.exported && s.exported.name) exportedNames.add(s.local ? s.local.name : s.exported.name);
        }
        // also surface `export ... from 'mod'` as an import edge
        if (node.source && typeof node.source.value === 'string') imports.push(node.source.value);
        continue;
      }
      decl = node.declaration;
      exported = true;
    } else if (node.type === 'ExportDefaultDeclaration') {
      decl = node.declaration;
      exported = true;
    } else if (node.type === 'ExportAllDeclaration') {
      if (node.source && typeof node.source.value === 'string') imports.push(node.source.value);
      continue;
    }

    if (!decl) continue;

    collectDeclSymbols(decl, code, symbols, exported);

    // import edges
    if (decl.type === 'ImportDeclaration' && decl.source && typeof decl.source.value === 'string') {
      imports.push(decl.source.value);
    }
  }

  // Reconcile CommonJS exports (module.exports = {…}, exports.foo = …) into the exported set, so the
  // `exported` flag is correct for CJS modules — which is most of this codebase.
  collectCjsExportNames(ast.program, exportedNames);

  // Reconcile `export { name }` + CJS export names against already-collected top-level symbols.
  if (exportedNames.size) {
    for (const s of symbols) {
      if (s.kind !== 'method' && exportedNames.has(s.name)) s.exported = true;
    }
  }

  // CommonJS require('x') specifiers count as imports too (repo is largely CJS).
  collectRequireSpecs(ast.program, imports);

  // Collect call names across the WHOLE file (one pass over the program). `require` is excluded —
  // it is captured as an import edge, not a meaningful call edge.
  const callsRaw = [];
  collectCallNames(ast.program, callsRaw);
  const calls = dedupePreserveOrder(callsRaw).filter((n) => n !== 'require');

  return { symbols, imports: dedupePreserveOrder(imports), calls };
}

// Extract symbols from a single declaration node (already unwrapped from any export wrapper).
function collectDeclSymbols(decl, code, symbols, exported) {
  switch (decl.type) {
    case 'FunctionDeclaration': {
      const name = decl.id ? decl.id.name : '(default)';
      symbols.push({
        name, kind: 'function',
        start_line: startLine(decl), end_line: endLine(decl),
        signature: fnSignature(name, decl, code), exported: !!exported,
      });
      break;
    }
    case 'ClassDeclaration': {
      const name = decl.id ? decl.id.name : '(default)';
      const superPart = decl.superClass && decl.superClass.name ? ` extends ${decl.superClass.name}` : '';
      symbols.push({
        name, kind: 'class',
        start_line: startLine(decl), end_line: endLine(decl),
        signature: `class ${name}${superPart}`, exported: !!exported,
      });
      extractClassMethods(decl, name, code, symbols);
      break;
    }
    case 'VariableDeclaration': {
      for (const d of decl.declarations) {
        const kind = initFnKind(d.init);
        if (!kind) continue; // only function/arrow consts become symbols
        const name = d.id && d.id.type === 'Identifier' ? d.id.name : '(anon)';
        const sig = kind === 'arrow'
          ? `${d.init.async ? 'async ' : ''}${name} = ${paramsSignature(d.init, code)} =>`
          : fnSignature(name, d.init, code);
        symbols.push({
          name, kind,
          start_line: startLine(d.init) || startLine(d),
          end_line: endLine(d.init) || endLine(d),
          signature: sig, exported: !!exported,
        });
      }
      break;
    }
    // A default-exported anonymous function/arrow/class expression.
    case 'FunctionExpression':
    case 'ArrowFunctionExpression': {
      const kind = decl.type === 'ArrowFunctionExpression' ? 'arrow' : 'function';
      symbols.push({
        name: '(default)', kind,
        start_line: startLine(decl), end_line: endLine(decl),
        signature: `(default) ${paramsSignature(decl, code)}${kind === 'arrow' ? ' =>' : ''}`,
        exported: !!exported,
      });
      break;
    }
    case 'ClassExpression': {
      const name = decl.id ? decl.id.name : '(default)';
      symbols.push({
        name, kind: 'class',
        start_line: startLine(decl), end_line: endLine(decl),
        signature: `class ${name}`, exported: !!exported,
      });
      extractClassMethods(decl, name, code, symbols);
      break;
    }
    default:
      break;
  }
}

function dedupePreserveOrder(arr) {
  const seen = new Set();
  const out = [];
  for (const v of arr) { if (!seen.has(v)) { seen.add(v); out.push(v); } }
  return out;
}

module.exports = {
  extractFromAst,
  // exported for unit testing of the internals
  collectCallNames,
  calleeName,
  paramsSignature,
};
