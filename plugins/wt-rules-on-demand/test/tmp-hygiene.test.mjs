import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';

test('each sibling test file leaves a fresh temporary directory empty', async (t) => {
  const self = fileURLToPath(import.meta.url);
  const dir = fileURLToPath(new URL('.', import.meta.url));
  const files = (await readdir(dir)).filter((name) => name.endsWith('.test.mjs') && join(dir, name) !== self);
  assert.ok(files.length >= 10);
  for (const file of files) {
    const temp = await mkdtemp(join(tmpdir(), 'rod-audit-'));
    try {
      const run = spawnSync(process.execPath, ['--test', join(dir, file)], { encoding: 'utf8', timeout: 30_000,
        env: cleanEnv({ TMPDIR: temp, TMP: temp, TEMP: temp }) });
      assert.equal(run.status, 0, `${file}: ${run.stderr || run.stdout}`);
      assert.deepEqual(await readdir(temp), [], `${file} left temporary files`);
    } finally { await rm(temp, { recursive: true, force: true }); }
  }
  t.diagnostic(`audited ${files.length} sibling test files`);
});
