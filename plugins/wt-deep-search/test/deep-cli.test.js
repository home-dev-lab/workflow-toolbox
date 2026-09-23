import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { chmod, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const cli = new URL('../bin/deep.mjs', import.meta.url);

async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'deep-cli-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'deep-search');
  await mkdir(directory);
  const env = { ...process.env, XDG_STATE_HOME: root };
  return {
    directory,
    env,
    run: (...args) => spawnSync(process.execPath, [cli.pathname, ...args], { env, encoding: 'utf8' }),
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

test('CLI refuses immediately without a deep provider and emits no handle', async (t) => {
  const f = await fixture(t);
  delete f.env.EXA_API_KEY;
  f.env.PATH = f.directory;
  const result = f.run('start', '--mode', 'deep-lite', '--question', 'question');
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
  assert.match(result.stderr, /set EXA_API_KEY/i);
  assert.match(result.stderr, /install opencode/i);
  assert.match(result.stderr, /ordinary web search still works/i);
});

test('CLI starts without an Exa key when opencode is resolvable', async (t) => {
  const f = await fixture(t);
  const opencode = join(f.directory, 'opencode');
  await writeFile(opencode, '#!/bin/sh\nexit 0\n');
  await chmod(opencode, 0o755);
  delete f.env.EXA_API_KEY;
  f.env.PATH = f.directory;
  f.env.DEEP_SEARCH_NO_WORKER = '1';
  const result = f.run('start', '--mode', 'deep-lite', '--question', 'question');
  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stdout, /^deep-[a-f0-9-]+\n$/);
  const handle = result.stdout.trim();
  const record = JSON.parse(await readFile(join(f.directory, `${handle}.json`), 'utf8'));
  assert.equal(record.opencodePath, opencode);
});

test('worker records a missing Exa key as missing before falling back', async (t) => {
  const f = await fixture(t);
  const opencode = join(f.directory, 'opencode');
  await writeFile(opencode, '#!/bin/sh\nexit 0\n');
  await chmod(opencode, 0o755);
  await f.write({
    handle: 'deep-one',
    status: 'running',
    engine: 'exa',
    mode: 'deep-lite',
    shape: 'prose',
    question: 'question',
    dir: f.directory,
    timeoutMs: 1_000,
    createdAt: 10,
    updatedAt: 10,
  });
  delete f.env.EXA_API_KEY;
  f.env.PATH = f.directory;
  const result = f.run('__worker', 'deep-one');
  assert.equal(result.status, 0, result.stderr);
  const record = JSON.parse(await readFile(join(f.directory, 'deep-one.json'), 'utf8'));
  assert.equal(record.exaClassification, 'missing');
  assert.match(record.exaError, /EXA_API_KEY.*not set/i);
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
  assert.equal(execFileSync(process.execPath, [cli.pathname, 'list'], { env: f.env, encoding: 'utf8' }), 'deep-one done exa\n');
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

test('CLI explains how to repair an opencode not-found exit', async (t) => {
  const f = await fixture(t);
  const logPath = join(f.directory, 'deep-one.log');
  await writeFile(logPath, '\nEXIT=127\n');
  await f.write({
    handle: 'deep-one',
    status: 'running',
    engine: 'opencode',
    shape: 'prose',
    logPath,
    createdAt: 10,
    updatedAt: 25,
  });
  const status = f.run('status', 'deep-one');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /opencode was not found/i);
  assert.match(status.stdout, /install opencode/i);
  const result = f.run('result', 'deep-one');
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /opencode was not found/i);
  assert.match(result.stderr, /install opencode/i);
});

test('CLI does not label a non-executable opencode as not found', async (t) => {
  const f = await fixture(t);
  const logPath = join(f.directory, 'deep-one.log');
  await writeFile(logPath, '\nSPAWN_ERROR=EACCES\nEXIT=126\n');
  await f.write({
    handle: 'deep-one',
    status: 'running',
    engine: 'opencode',
    shape: 'prose',
    logPath,
    createdAt: 10,
    updatedAt: 25,
  });
  const status = f.run('status', 'deep-one');
  assert.equal(status.status, 0, status.stderr);
  assert.match(status.stdout, /failed to start: EACCES/i);
  assert.doesNotMatch(status.stdout, /not found|install opencode/i);
});
