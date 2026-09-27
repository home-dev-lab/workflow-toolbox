import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';

const scanner = fileURLToPath(new URL('../scripts/transcript-verdicts.mjs', import.meta.url));
test('default projects dir follows CLAUDE_CONFIG_DIR rather than another profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  const projects = join(config, 'projects');
  await mkdir(projects, { recursive: true });
  await writeFile(join(projects, 'sample.jsonl'), JSON.stringify({ type: 'assistant', cwd: '/fixture', timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'fixture-use', name: 'Agent', input: {} }] } }) + '\n');
   const run = spawnSync(process.execPath, [scanner], { encoding: 'utf8', env: cleanEnv({ CLAUDE_CONFIG_DIR: config, HOME: join(root, 'other-home') }) });
  assert.match(run.stdout, /files read: 1/);
});
