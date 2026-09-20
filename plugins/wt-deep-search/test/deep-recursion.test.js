import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { startOpencode } from '../src/deep/opencode.js';
import { continueDeepResearch } from '../src/deep/runner.js';
import { ProviderFailure } from '../src/provider-failure.js';

const cli = new URL('../bin/deep.mjs', import.meta.url);

// ⚠ Measured 2026-09-21 00:39 +01:00, on the first REAL run. Exa refused, the availability door
// launched `opencode run --auto --dir <the plugin's own directory>`, and the agent — doing exactly
// what an agent does — read the plugin it found there, ran `bin/deep.mjs start` itself with a
// reworded question, and each child did the same. Seven runs in two minutes before they were
// killed by hand. Nothing in the code said "do not recurse", and nothing bounded it.

async function stateRoot(t) {
  const root = await mkdtemp(join(tmpdir(), 'deep-recursion-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  return root;
}

test('a deep-search worker refuses to start another deep-search run', async (t) => {
  const root = await stateRoot(t);
  const env = { ...process.env, XDG_STATE_HOME: root, DEEP_SEARCH_WORKER: '1' };
  const result = spawnSync(process.execPath, [cli.pathname, 'start', '--mode', 'deep-lite', '--question', 'anything'], { env, encoding: 'utf8' });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /already inside a deep-search run/i);
});

test('the opencode child carries the marker that makes recursion refusable', () => {
  let seen = null;
  startOpencode(
    { prompt: 'a full brief', dir: '/tmp/work', logPath: '/tmp/work/run.log' },
    { spawn: (_command, _args, options) => { seen = options; return { pid: 1, unref() {} }; } },
  );
  assert.equal(seen?.env?.DEEP_SEARCH_WORKER, '1');
});

test('an agentic run never works inside the plugin that launched it', async (t) => {
  const root = await stateRoot(t);
  const env = { ...process.env, XDG_STATE_HOME: root };
  const result = spawnSync(
    process.execPath,
    [cli.pathname, 'start', '--mode', 'agentic', '--question', 'anything', '--json'],
    { env, encoding: 'utf8', cwd: new URL('..', cli).pathname },
  );
  assert.equal(result.status, 0, result.stderr);
  const { handle } = JSON.parse(result.stdout);
  const record = JSON.parse(spawnSync(process.execPath, ['-e', `process.stdout.write(require('fs').readFileSync(process.argv[1],'utf8'))`, join(root, 'deep-search', `${handle}.json`)], { encoding: 'utf8' }).stdout);
  assert.equal(record.dir.startsWith(join(root, 'deep-search')), true, `dir was ${record.dir}`);
});

test('the Exa failure that opened the availability door is recorded', async () => {
  const updates = [];
  const store = {
    directory: '/state/deep-search',
    update: async (handle, patch) => { updates.push(patch); return { handle, ...patch }; },
  };
  await continueDeepResearch('deep-1', { mode: 'deep', question: 'q', dir: '/work' }, {
    store,
    exa: {
      run: async () => {
        throw new ProviderFailure('Exa refused: 402 insufficient credit', {
          provider: 'exa',
          classification: 'exhausted',
          status: 402,
        });
      },
    },
    opencode: { start: async () => ({ logPath: '/state/deep-search/deep-1.log', pid: 7 }) },
  });
  const switched = updates.find((patch) => patch.door === 'availability');
  assert.equal(switched.exaError, 'Exa refused: 402 insufficient credit');
  assert.equal(switched.exaClassification, 'exhausted');
});
