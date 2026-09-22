import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const cli = new URL('../bin/deep.mjs', import.meta.url);
const cliPath = fileURLToPath(cli);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'deep-cli-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'deep-search');
  await mkdir(directory);
  const env = { ...process.env, XDG_STATE_HOME: root };
  return {
    directory,
    env,
    run: (...args) => spawnSync(process.execPath, [cliPath, ...args], { env, encoding: 'utf8' }),
    write: async (record) => writeFile(
      join(directory, `${record.handle}.json`),
      JSON.stringify(record),
    ),
  };
}

test('CLI rejects an unknown mode with a sentence naming it', async (t) => {
  const f = await fixture(t);
  const result = f.run('start', '--mode', 'automatic', '--question', 'question');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown deep-search mode: automatic/);
});

test('CLI rejects a missing question with a sentence naming it', async (t) => {
  const f = await fixture(t);
  const result = f.run('start', '--mode', 'deep');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Missing deep-search question/);
});

test('CLI rejects an unknown handle with a sentence naming it', async (t) => {
  const f = await fixture(t);
  const result = f.run('status', 'deep-missing');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /Unknown deep-search handle: deep-missing/);
});

test('CLI status names state, engine, and elapsed time', async (t) => {
  const f = await fixture(t);
  await f.write({ handle: 'deep-one', status: 'done', engine: 'exa', createdAt: 10, updatedAt: 25 });
  const result = f.run('status', 'deep-one');
  assert.equal(result.status, 0);
  assert.equal(result.stdout, 'done exa 15ms\n');
});

test('CLI result exits non-zero and explains a run that is not done', async (t) => {
  const f = await fixture(t);
  await f.write({ handle: 'deep-one', status: 'running', engine: 'exa', createdAt: 10, updatedAt: 25 });
  const result = f.run('result', 'deep-one');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /deep-one is running, not done/);
  assert.equal(result.stdout, '');
});

test('CLI result emits the requested consumer shape', async (t) => {
  const f = await fixture(t);
  await f.write({
    handle: 'deep-one',
    status: 'done',
    engine: 'exa',
    shape: 'structured',
    result: { claims: [{ claim: 'C', url: 'https://example.com', date: null }], unverified: [] },
    createdAt: 10,
    updatedAt: 25,
  });
  const result = f.run('result', 'deep-one', '--shape', 'structured');
  assert.equal(result.status, 0);
  assert.deepEqual(JSON.parse(result.stdout), {
    engine: 'exa',
    costDollars: null,
    claims: [{ claim: 'C', url: 'https://example.com', date: null }],
    unverified: [],
  });
});

test('CLI list prints persisted handles without loading repository data', async (t) => {
  const f = await fixture(t);
  await f.write({ handle: 'deep-one', status: 'done', engine: 'exa', createdAt: 10, updatedAt: 25 });
  assert.equal(execFileSync(process.execPath, [cliPath, 'list'], { env: f.env, encoding: 'utf8' }), 'deep-one done exa\n');
});

test('CLI reconciles an opencode EXIT marker before returning a result', async (t) => {
  const f = await fixture(t);
  const logPath = join(f.directory, 'deep-one.log');
  await writeFile(logPath, 'Agent answer with [source](https://example.com).\nEXIT=0\n');
  await f.write({
    handle: 'deep-one',
    status: 'running',
    engine: 'opencode',
    shape: 'prose',
    logPath,
    createdAt: 10,
    updatedAt: 25,
  });
  const result = f.run('result', 'deep-one');
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Answered by opencode/);
  assert.match(result.stdout, /Agent answer with \[source\]/);
});
