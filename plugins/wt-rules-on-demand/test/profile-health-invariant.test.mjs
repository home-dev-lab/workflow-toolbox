import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanEnv } from './clean-env.mjs';

test('health never changes outcomes across the dynamically discovered existing profile fixture matrix', async () => {
  const directory = fileURLToPath(new URL('./', import.meta.url));
  const files = (await fs.readdir(directory)).filter((name) => /^profile-(?:policy.*|safety)\.test\.mjs$/.test(name));
  assert.ok(files.length > 0, 'profile fixture matrix must not be empty');
  const preload = fileURLToPath(new URL('../test-support/profile-matrix-preload.mjs', import.meta.url));
  const env = cleanEnv();
  delete env.NODE_TEST_CONTEXT;
  const result = spawnSync(process.execPath, ['--import', pathToFileURL(preload).href, '--test', ...files], { cwd: directory, encoding: 'utf8', env, timeout: 60000, maxBuffer: 4 * 1024 * 1024 });
  assert.equal(result.status, 0, `fixture matrix must be health-independent:\n${result.stdout}\n${result.stderr}`);
  assert.ok(result.stdout.includes('PROFILE-MATRIX-COMPARED'), 'the existing CLI fixtures must actually be compared');
});
