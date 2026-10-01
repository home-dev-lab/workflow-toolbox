// Static host-shape lock. This deliberately scans source text rather than parsing JS:
// it can miss aliases of $, multiline call expressions and closures split across
// lines, and may flag a matching sequence in a comment or string. Keep the real
// Claude plugin validator as the authoritative full module-graph check.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

const memberCall = /(?:\]|\.\w+)\s*\(\s*\$[,)]/g;
const dollarUse = /\b\w+\(\s*\$[,)]|\$\.(?:fs|env|store|ui|session|model)\b/g;
const propertyFunction = /:\s*async\s*\(\s*\$|:\s*function\s*\(/g;
const importedName = /\bimport\s*\{([^}]+)\}\s*from\s*['"](?:\.\.?\/)[^'"]+['"]/g;
const importedDefault = /\bimport\s+([A-Za-z_$][\w$]*)\s+from\s*['"](?:\.\.?\/)[^'"]+['"]/g;
const importedNamespace = /\bimport\s+\*\s+as\s+([A-Za-z_$][\w$]*)\s+from\s*['"](?:\.\.?\/)[^'"]+['"]/g;

function violations(source, name = 'hooks.js') {
  const errors = [];
  const imports = new Set([...source.matchAll(importedName)].flatMap((match) => match[1].split(',').map((part) => part.trim().split(' as ').at(-1))));
  for (const match of source.matchAll(importedDefault)) imports.add(match[1]);
  for (const match of source.matchAll(importedNamespace)) imports.add(match[1]);
  for (const imported of imports) {
    const call = new RegExp(`\\b${imported}\\s*\\(\\s*\\$[,)]`, 'g');
    for (const match of source.matchAll(call)) errors.push(`imported $ argument: ${match[0]}`);
  }
  if (name !== 'hooks.js') {
    for (const match of source.matchAll(/\(\s*\$[,)]|\$\./g))
      errors.push(`$ outside hooks.js: ${match[0]}`);
  }
  // The host lists the variables a module reads: $.env.get takes a string literal, never a variable.
  for (const match of source.matchAll(/\$\.env\.get\(([^)]*)\)/g)) {
    if (!/^['"]/.test(match[1].trimStart())) errors.push(`non-literal env name: ${match[0]}`);
  }
  // The validator requires $.noun.event(...) at the call site: a member read as a value (typeof, a test, a reference) is refused.
  for (const match of source.matchAll(/\$\.\w+\.\w+(?!\w|\s*\()/g)) errors.push(`$ member used as a value: ${match[0]}`);
  for (const [label, pattern] of [['computed/member $ argument', memberCall], ['object-property $ function', propertyFunction]]) {
    for (const match of source.matchAll(pattern)) errors.push(`${label}: ${match[0]}`);
  }
  for (const line of source.split('\n')) {
    const arrow = line.indexOf('=>');
    const expression = line.indexOf('function (');
    let start = -1;
    if (arrow >= 0) start = arrow + 2;
    else if (expression >= 0) start = expression + 'function ('.length;
    if (start >= 0) for (const match of line.slice(start).matchAll(dollarUse)) errors.push(`captured $ in expression: ${match[0]}`);
  }
  return errors;
}

test('host-shape scanner catches forbidden computed calls and captured expressions', () => {
  assert.match(violations('DETECTORS[name]($, e, ctx)').join('\n'), /computed\/member/);
  assert.match(violations('helper.member($, e)').join('\n'), /computed\/member/);
  assert.match(violations('budget.outside(() => detect($, e))').join('\n'), /captured/);
  assert.match(violations('work(function () { return $.fs.read(path); })').join('\n'), /captured/);
  assert.match(violations("'detector': async ($, event) => $.fs.read(event.path)").join('\n'), /object-property/);
  assert.match(violations("import { lspSymbolGrep } from './lsp-symbol.js';\nawait lspSymbolGrep($, e, ctx);").join('\n'), /imported \$ argument/);
  assert.match(violations("import { lspSymbolGrep as scan } from './lsp-symbol.js';\nawait scan($, e);").join('\n'), /imported \$ argument/);
  assert.match(violations("import scan from './lsp-symbol.js';\nawait scan($, e);").join('\n'), /imported \$ argument/);
  assert.match(violations("import * as scan from './lsp-symbol.js';\nawait scan($, e);").join('\n'), /imported \$ argument/);
  assert.match(violations('function servedExtensions($, env) {}', 'lsp-symbol.js').join('\n'), /outside hooks.js/);
  assert.match(violations('await $.fs.read(file)', 'lsp-symbol.js').join('\n'), /outside hooks.js/);
  assert.match(violations('value = await $.env.get(path);').join('\n'), /non-literal env name/);
  assert.match(violations("const keys = typeof $.store.keys === 'function' ? await $.store.keys() : [];").join('\n'), /used as a value/);
  assert.match(violations('if ($.fs.exists) await $.fs.exists(path);').join('\n'), /used as a value/);
  assert.deepEqual(violations("await detect($, e); await $.fs.read(path); await $.env.get('PATH');"), []);
});

test('Function Hooks files contain no forbidden $ flow shapes', async () => {
  const root = new URL('../hooks/', import.meta.url);
  const files = (await readdir(root)).filter((name) => name.endsWith('.js'));
  const failures = [];
  for (const name of files) {
    const source = await readFile(new URL(name, root), 'utf8');
    for (const error of violations(source, name)) failures.push(`${name}: ${error}`);
  }
  assert.deepEqual(failures, []);
});
