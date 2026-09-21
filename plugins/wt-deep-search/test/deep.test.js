import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildExaSearchRequest, runExaDeepSearch } from '../src/deep/exa-search.js';
import { formatResult } from '../src/deep/format.js';
import { createHandleStore, resolveStateDirectory } from '../src/deep/handle.js';
import { startOpencode } from '../src/deep/opencode.js';
import { buildDeepPrompt } from '../src/deep/prompt.js';
import { startDeepResearch } from '../src/deep/runner.js';
import { ProviderFailure } from '../src/provider-failure.js';

const question = 'How should a team compare current battery recycling methods and their tradeoffs?';

test('the fast hook has no opencode invocation or deep import', async () => {
  const source = await readFile(new URL('../hooks/hooks.js', import.meta.url), 'utf8');
  assert.doesNotMatch(source, /(?:spawn|run|exec).*opencode/i);
  assert.doesNotMatch(source, /from\s+['"]\.\.\/src\/deep\//);
});

test('start returns a handle without awaiting a research engine', async () => {
  const records = [];
  const store = {
    create: async (record) => { records.push(record); return { ...record, handle: 'deep-1' }; },
    update: async () => {},
  };
  const never = new Promise(() => {});
  const result = await Promise.race([
    startDeepResearch(
      { mode: 'deep', question, shape: 'prose' },
      { store, exa: { run: () => never } },
    ),
    new Promise((resolve) => setTimeout(() => resolve('timed out'), 30)),
  ]);
  assert.deepEqual(result, { handle: 'deep-1' });
  assert.equal(records[0].status, 'running');
});

// ⚠ These three tests used to assert that an Exa AGENT run refused an omitted effort, `auto`
// ($5 per run) and `max` ($20 per run). That product is RETIRED: measured 2026-09-21 00:45 +01:00,
// `POST https://api.exa.ai/research/v1` answers 410 RESEARCH_RETIRED. The deep rungs go through
// /search, which takes no effort at all — so the lock that replaces them refuses to SEND one,
// which is what stops a caller believing a parameter does something it cannot.
test('Exa search refuses an effort, because that parameter belonged to the retired product', async () => {
  await assert.rejects(
    runExaDeepSearch({ mode: 'deep', question, shape: 'prose', effort: 'low', apiKey: 'key' }, { fetch: async () => {} }),
    /takes no effort.*retired Research API/i,
  );
});

test('Exa search refuses a type that is not one of the six', () => {
  assert.throws(
    () => buildExaSearchRequest({ prompt: question, mode: 'agentic', outputSchema: { type: 'text' } }),
    /Unknown Exa search type: agentic/,
  );
});

test('Exa search refuses a missing output schema, which is what makes deep-reasoning write prose', () => {
  assert.throws(
    () => buildExaSearchRequest({ prompt: question, mode: 'deep-reasoning', outputSchema: null }),
    /requires an output schema/i,
  );
});

test('deep-reasoning prose sends a text output schema to /search', async () => {
  let url;
  let body;
  const fetch = async (target, init) => {
    url = target;
    body = JSON.parse(init.body);
    return response(200, { output: { content: 'answer' }, costDollars: { total: 0.012 } });
  };
  await runExaDeepSearch({ mode: 'deep-reasoning', question, shape: 'prose', apiKey: 'key' }, { fetch });
  assert.equal(url, 'https://api.exa.ai/search');
  assert.equal(body.type, 'deep-reasoning');
  assert.equal(body.query, question);
  assert.deepEqual(body.outputSchema, { type: 'text' });
  assert.equal('effort' in body, false);
});

test('deep-reasoning structured sends a claim schema', async () => {
  let body;
  const fetch = async (_url, init) => {
    body = JSON.parse(init.body);
    return response(200, { output: { content: {} }, costDollars: { total: 0.012 } });
  };
  await runExaDeepSearch({ mode: 'deep-reasoning', question, shape: 'structured', apiKey: 'key' }, { fetch });
  assert.equal(body.outputSchema.type, 'object');
  assert.ok(body.outputSchema.properties.claims.items.properties.claim);
  assert.ok(body.outputSchema.properties.claims.items.properties.url);
  assert.ok(body.outputSchema.properties.claims.items.properties.date);
  assert.ok(body.outputSchema.properties.unverified);
});

test('Exa search answers in ONE call and carries the cost the call reported', async () => {
  const requests = [];
  const fetch = async (url, init) => {
    requests.push([url, init]);
    return response(200, {
      output: { content: 'researched answer', grounding: [{ url: 'https://example.test' }] },
      results: [{}, {}],
      costDollars: { total: 0.012 },
    });
  };
  const result = await runExaDeepSearch(
    { mode: 'deep', question, shape: 'prose', apiKey: 'key' },
    { fetch },
  );
  assert.equal(result.content, 'researched answer');
  // The figure a run reports about ITSELF, never one quoted from a price list.
  assert.equal(result.costDollars, 0.012);
  assert.equal(result.grounding.length, 1);
  assert.equal(requests.length, 1);
  assert.equal(requests[0][1].method, 'POST');
});

test('Exa search reuses provider classification for credit and 5xx failures', async () => {
  let creditCalls = 0;
  await assert.rejects(
    runExaDeepSearch(
      { mode: 'deep', question, shape: 'prose', apiKey: 'key' },
      {
        fetch: async () => {
          creditCalls += 1;
          return response(402, { error: 'insufficient credits' });
        },
        sleep: async () => {},
      },
    ),
    (error) => error instanceof ProviderFailure && error.classification === 'exhausted',
  );
  assert.equal(creditCalls, 1);

  let serverCalls = 0;
  await assert.rejects(
    runExaDeepSearch(
      { mode: 'deep', question, shape: 'prose', apiKey: 'key' },
      {
        fetch: async () => {
          serverCalls += 1;
          return response(503, { error: 'unavailable' });
        },
        sleep: async () => {},
      },
    ),
    (error) => error instanceof ProviderFailure && error.classification === 'transient',
  );
  assert.equal(serverCalls, 3);
});

test('fast and instant prompts are short keyword queries', () => {
  for (const mode of ['fast', 'instant']) {
    const prompt = buildDeepPrompt({ mode, question });
    assert.equal(typeof prompt, 'string');
    assert.ok(prompt.length < question.length, `${mode} prompt was not shortened`);
    assert.doesNotMatch(prompt, /\?$/);
  }
});

test('deep and deep-reasoning prompts preserve the prose question', () => {
  for (const mode of ['deep', 'deep-reasoning']) {
    assert.equal(buildDeepPrompt({ mode, question }), question);
  }
});

test('agentic prompt is a full research brief', () => {
  const prompt = buildDeepPrompt({ mode: 'agentic', question });
  assert.match(prompt, /Research objective:/);
  assert.match(prompt, new RegExp(question.replace(/[?]/g, '\\?')));
  assert.match(prompt, /inline citation/i);
  assert.match(prompt, /could not be verified/i);
});

test('an unknown mode is refused instead of classified from question text', () => {
  assert.throws(() => buildDeepPrompt({ mode: 'automatic', question }), /Unknown deep-search mode: automatic/);
});

test('the difficulty door is recorded for caller-selected agentic mode', async () => {
  const { store, records } = memoryStore();
  let prompt;
  const answer = await startDeepResearch(
    { mode: 'agentic', question, shape: 'prose' },
    { store, opencode: { start: async (options) => {
      prompt = options.prompt;
      return { logPath: '/state/run.log', pid: 12 };
    } } },
  );
  assert.equal(answer.handle, 'deep-1');
  assert.equal(records.get('deep-1').door, 'difficulty');
  assert.equal(records.get('deep-1').engine, 'opencode');
  assert.match(prompt, /Research objective:/);
  assert.match(prompt, /inline citation/i);
});

test('the availability door is recorded when exhausted Exa switches to opencode', async () => {
  const { store, records } = memoryStore();
  await startDeepResearch(
    { mode: 'deep', question, shape: 'prose' },
    {
      store,
      exa: { run: async () => { throw new ProviderFailure('credit', { provider: 'exa', classification: 'exhausted' }); } },
      opencode: { start: async () => ({ logPath: '/state/run.log', pid: 13 }) },
    },
  );
  await settles();
  assert.equal(records.get('deep-1').door, 'availability');
  assert.equal(records.get('deep-1').engine, 'opencode');
});

test('a rate-limited Exa run switches only after provider retries are exhausted', async () => {
  const { store, records } = memoryStore();
  let fetchCalls = 0;
  await startDeepResearch(
    { mode: 'deep', question, shape: 'prose' },
    {
      store,
      exa: { run: (options) => runExaDeepSearch(
        { ...options, apiKey: 'key' },
        {
          fetch: async () => {
            fetchCalls += 1;
            return response(429, { error: 'rate limit' });
          },
          sleep: async () => {},
        },
      ) },
      opencode: { start: async () => ({ logPath: '/state/run.log', pid: 14 }) },
    },
  );
  await settles();
  assert.equal(fetchCalls, 3);
  assert.equal(records.get('deep-1').door, 'availability');
  assert.equal(records.get('deep-1').engine, 'opencode');
});

test('a transient Exa failure does not switch engines', async () => {
  const { store, records } = memoryStore();
  let opencodeCalls = 0;
  await startDeepResearch(
    { mode: 'deep', question, shape: 'prose' },
    {
      store,
      exa: { run: async () => { throw new ProviderFailure('server', { provider: 'exa', classification: 'transient' }); } },
      opencode: { start: async () => { opencodeCalls += 1; } },
    },
  );
  await settles();
  assert.equal(opencodeCalls, 0);
  assert.equal(records.get('deep-1').status, 'failed');
  assert.equal(records.get('deep-1').engine, 'exa');
});

test('the engine that answered is named in prose and structured results', () => {
  const record = {
    status: 'done',
    engine: 'opencode',
    result: {
      prose: 'Supported assertion [Example](https://example.com).',
      claims: [{ claim: 'Supported assertion', url: 'https://example.com', date: '2026-09-20' }],
      unverified: ['A second assertion'],
    },
  };
  assert.match(formatResult(record, { shape: 'prose' }), /Answered by opencode/);
  assert.deepEqual(formatResult(record, { shape: 'structured' }), {
    engine: 'opencode',
    // What this run actually cost, or null when the engine reported nothing — an opencode run
    // spends a subscription, so it has no dollar figure and must not invent one.
    costDollars: null,
    claims: record.result.claims,
    unverified: record.result.unverified,
  });
});

test('state records default outside the repository under XDG or HOME', () => {
  assert.equal(
    resolveStateDirectory({ env: { XDG_STATE_HOME: '/state', HOME: '/home/test' }, cwd: '/repo' }),
    '/state/deep-search',
  );
  assert.equal(
    resolveStateDirectory({ env: { HOME: '/home/test' }, cwd: '/repo' }),
    '/home/test/.local/state/deep-search',
  );
});

test('a relative state path inside the repository is refused', () => {
  assert.throws(
    () => resolveStateDirectory({ env: { XDG_STATE_HOME: '.state', HOME: '/home/test' }, cwd: '/repo' }),
    /XDG_STATE_HOME must be an absolute path/,
  );
});

test('handle records can be created, read, updated, and listed', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'deep-search-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  let tick = 0;
  const store = createHandleStore({ env: { XDG_STATE_HOME: root }, now: () => ++tick, randomUUID: () => 'abc' });
  const created = await store.create({ status: 'running', engine: 'exa' });
  assert.equal(created.handle, 'deep-abc');
  assert.equal(created.createdAt, 1);
  assert.deepEqual(await store.read('deep-abc'), created);
  const updated = await store.update('deep-abc', { status: 'done' });
  assert.equal(updated.updatedAt, 2);
  assert.equal(updated.status, 'done');
  assert.deepEqual(await store.list(), [updated]);
  await assert.rejects(store.read('../escape'), /Unknown deep-search handle/);
});

test('opencode launch uses an argument array without a shell', () => {
  let launch;
  const child = { pid: 44, once() {}, unref() {} };
  const result = startOpencode(
    { prompt: 'full brief', dir: '/work', logPath: '/state/deep-1.log', timeoutMs: 90_000 },
    {
      closeSync() {},
      openSync: () => 8,
      spawn: (...args) => { launch = args; return child; },
      setTimeout: () => ({ unref() {} }),
    },
  );
  assert.equal(launch[0], 'opencode');
  assert.deepEqual(launch[1], ['run', '--auto', '--dir', '/work', 'full brief']);
  assert.equal(launch[2].shell, false);
  assert.equal(launch[2].detached, true);
  assert.deepEqual(launch[2].stdio, ['ignore', 8, 8]);
  assert.deepEqual(result, { logPath: '/state/deep-1.log', pid: 44 });
});

test('opencode timeout is owned by Node, kills the child, and records the timeout', () => {
  let onExit;
  let onTimeout;
  let killed = false;
  const writes = [];
  const child = {
    pid: 44,
    kill() { killed = true; },
    once(event, callback) { if (event === 'exit') onExit = callback; },
    unref() {},
  };
  startOpencode(
    { prompt: 'full brief', dir: '/work', logPath: '/state/deep-1.log', timeoutMs: 90_000 },
    {
      appendFileSync: (_path, value) => writes.push(value),
      clearTimeout() {},
      closeSync() {},
      openSync: () => 8,
      setTimeout: (callback) => { onTimeout = callback; return 7; },
      spawn: () => child,
    },
  );

  onTimeout();
  onExit(null, 'SIGTERM');
  assert.equal(killed, true);
  assert.deepEqual(writes, ['\nTIMEOUT=90000\nEXIT=124\n']);
});

test('opencode accepts Windows absolute paths and refuses relative paths', () => {
  const deps = {
    closeSync() {},
    openSync: () => 8,
    setTimeout: () => 7,
    spawn: () => ({ pid: 44, once() {}, unref() {} }),
  };
  assert.doesNotThrow(() => startOpencode({
    prompt: 'full brief',
    dir: String.raw`C:\work`,
    logPath: String.raw`C:\state\deep-1.log`,
  }, deps));
  assert.throws(
    () => startOpencode({ prompt: 'full brief', dir: 'work', logPath: '/state/deep-1.log' }, deps),
    /absolute --dir/,
  );
  assert.throws(
    () => startOpencode({ prompt: 'full brief', dir: '/work', logPath: 'deep-1.log' }, deps),
    /absolute log path/,
  );
});

test('opencode receives only the environment it needs, never provider or unrelated credentials', () => {
  let launch;
  const env = {
    PATH: '/usr/bin',
    HOME: '/home/tester',
    LANG: 'C.UTF-8',
    EXA_API_KEY: 'sentinel-exa-secret',
    BRAVE_API_KEY: 'sentinel-brave-secret',
    UNRELATED_CREDENTIAL: 'sentinel-unrelated-secret',
  };
  startOpencode(
    { prompt: 'full brief', dir: '/work', logPath: '/state/deep-1.log' },
    {
      closeSync() {},
      env,
      openSync: () => 8,
      setTimeout: () => 7,
      spawn: (...args) => { launch = args; return { pid: 45, once() {}, unref() {} }; },
    },
  );

  assert.deepEqual(launch[2].env, {
    PATH: '/usr/bin',
    HOME: '/home/tester',
    LANG: 'C.UTF-8',
    DEEP_SEARCH_WORKER: '1',
  });
});

test('package metadata keeps runtime and development dependencies empty', async () => {
  const packageJson = JSON.parse(await readFile(new URL('../package.json', import.meta.url), 'utf8'));
  assert.equal(Object.keys(packageJson.dependencies ?? {}).length, 0);
  assert.equal(Object.keys(packageJson.devDependencies ?? {}).length, 0);
});

function response(status, body) {
  return { status, json: async () => body, headers: { get: () => null } };
}

function memoryStore() {
  const records = new Map();
  return {
    records,
    store: {
      create: async (record) => {
        const saved = { ...record, handle: 'deep-1' };
        records.set(saved.handle, saved);
        return saved;
      },
      update: async (handle, patch) => {
        const saved = { ...records.get(handle), ...patch };
        records.set(handle, saved);
        return saved;
      },
    },
  };
}

function settles() {
  return new Promise((resolve) => setTimeout(resolve, 10));
}
