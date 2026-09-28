import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('Function Hooks entry has no transitive Node builtin imports', async () => {
  const seen = new Set();
  const walk = async (url) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = await readFile(url, 'utf8');
    const imports = source.split('\n').filter((line) => /^\s*(?:import|export)\s/.test(line))
      .flatMap((line) => [...line.matchAll(/\b(?:from\s*|import\s*)['"]([^'"]+)['"]/g)].map((match) => match[1]));
    for (const specifier of imports) {
      assert.ok(specifier.startsWith('.'), `${url.pathname} imports ${specifier}`);
      await walk(new URL(specifier, url));
    }
  };
  await walk(new URL('../hooks/hooks.js', import.meta.url));
  assert.ok(seen.size >= 4);
});
