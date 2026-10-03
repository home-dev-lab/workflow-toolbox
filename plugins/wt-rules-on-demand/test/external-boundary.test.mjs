import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';

// Conservative source check for checkout-relative URLs, imports and literal
// filesystem reads. externalTest is the sole API for checkout dependencies;
// it exposes their URL only to a callback registered with a visible skip.
function escapes(path, parent, root) {
  const url = new URL(path.replaceAll('\\', '/'), parent);
  return url.protocol === 'file:' && !url.href.startsWith(root.href);
}
function unguardedReads(source, file, root) {
  const violations = [];
  const modulePaths = /(?:new\s+URL\s*\(\s*|\bimport\s*\(\s*|\bfrom\s+|\bimport\s+)(['"`])((?:\.\.?[/\\])[^'"`]+)\1/g;
  const cwdPaths = /\b(?:readFile(?:Sync)?|readdir(?:Sync)?|cp(?:Sync)?|stat(?:Sync)?|access(?:Sync)?)\s*\(\s*(['"`])((?:\.\.?[/\\])[^'"`]+)\1/g;
  for (const [pattern, parent] of [[modulePaths, file], [cwdPaths, root]]) {
    for (const match of source.matchAll(pattern)) {
      if (escapes(match[2], parent, root)) violations.push(match[2]);
    }
  }
  return violations;
}

test('test checkout reads outside the plugin use externalTest', async () => {
  const root = new URL('../', import.meta.url);
  const failures = [];
  async function scan(dir) {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const url = new URL(entry.name, dir);
      if (entry.isDirectory()) await scan(new URL(`${entry.name}/`, dir));
      else if (/\.(?:mjs|js)$/.test(entry.name)) {
        for (const path of unguardedReads(await readFile(url, 'utf8'), url, root)) {
          failures.push(`${url.href.slice(root.href.length)}: ${path}`);
        }
      }
    }
  }
  await scan(new URL('./', import.meta.url));
  assert.deepEqual(failures, [], 'unguarded external test read; use externalTest');
});

test('external boundary check catches URL, import and filesystem escapes on POSIX and Windows URLs', () => {
  for (const root of [new URL('file:///checkout/plugin/'), new URL('file:///C:/checkout/plugin/')]) {
    const file = new URL('test/example.mjs', root);
    for (const expression of ['new URL', 'import', 'readFile', 'readdir', 'cp']) {
      const source = `${expression}('../../../outside/file', import.meta.url)`;
      assert.deepEqual(unguardedReads(source, file, root), ['../../../outside/file']);
    }
    assert.deepEqual(unguardedReads(['import x from', "'../../sibling/module.js'"].join(' '), file, root), ['../../sibling/module.js']);
    assert.deepEqual(unguardedReads("new URL('../hooks/hooks.js', import.meta.url)", file, root), []);
    assert.deepEqual(unguardedReads("externalTest('../../../outside/file', import.meta.url)", file, root), []);
  }
});
