import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';
import { fileURLToPath } from 'node:url';

test('Function Hooks imports and three event channels run without process, with and without cwd', async () => {
  const script = await readFile(new URL('./fixtures/host-vm.txt', import.meta.url), 'utf8');
   const run = spawnSync(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', script], { encoding: 'utf8', cwd: fileURLToPath(new URL('./fixtures/', import.meta.url)), env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
});

// Node's global `process`, however reached; the host's `$.process` noun is another object, always present where it is called.
const nodeProcess = /(?<!\$\.)\bprocess\b/;

test('the Node process pattern finds the global, never the host noun', () => {
  for (const line of ['process.env.X', 'globalThis.process.env', 'const { env } = process;']) assert.match(line, nodeProcess, line);
  assert.doesNotMatch("await $.process.run(['node'], { timeoutMs: 1 })", nodeProcess);
});

test('every hooks import process reference has a typeof guard', async () => {
  const visited = new Set();
  async function visit(url) {
    if (visited.has(url.href)) return;
    visited.add(url.href);
    const source = await readFile(url, 'utf8');
    for (const line of source.split('\n')) {
      if (nodeProcess.test(line)) assert.match(line, /typeof process\s*!==\s*['"]undefined['"]/, `${fileURLToPath(url)}: ${line.trim()}`);
    }
    for (const match of source.matchAll(/from\s+['"](\.[^'"]+)['"]/g)) await visit(new URL(match[1], url));
  }
  await visit(new URL('../hooks/hooks.js', import.meta.url));
});
