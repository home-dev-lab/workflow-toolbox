import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { buildExaSearchRequest, runExaDeepSearch } from '../src/deep/exa-search.js';
import { formatResult } from '../src/deep/format.js';
import { createHandleStore, resolveStateDirectory } from '../src/deep/handle.js';
import { resolveWindowsCommandShim, startOpencode } from '../src/deep/opencode.js';
import { buildDeepPrompt } from '../src/deep/prompt.js';
import { startDeepResearch } from '../src/deep/runner.js';
import { ProviderFailure } from '../src/provider-failure.js';

const question = 'How should a team compare current battery recycling methods and their tradeoffs?';

async function waitFor(check, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return Boolean(await check());
}

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

test('the resolved opencode path reaches the launch seam', async () => {
  const { store } = memoryStore();
  let executable;
  await startDeepResearch(
    { mode: 'agentic', question, shape: 'prose', opencodePath: '/resolved/opencode' },
    { store, opencode: { start: async (options) => {
      executable = options.executable;
      return { logPath: '/state/run.log', pid: 12 };
    } } },
  );
  assert.equal(executable, '/resolved/opencode');
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
    join('/state', 'deep-search'),
  );
  assert.equal(
    resolveStateDirectory({ env: { HOME: '/home/test' }, cwd: '/repo' }),
    join('/home/test', '.local', 'state', 'deep-search'),
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

test('opencode names asynchronous ENOENT without mislabelling other spawn errors', () => {
  for (const [code, marker] of [['ENOENT', 'EXIT=127'], ['EACCES', 'EXIT=126']]) {
    let onError;
    const writes = [];
    startOpencode(
      { prompt: 'full brief', dir: '/work', logPath: '/state/deep-1.log' },
      {
        appendFileSync: (_path, value) => writes.push(value),
        closeSync() {},
        openSync: () => 8,
        setTimeout: () => 7,
        spawn: () => ({ pid: undefined, once(event, callback) { if (event === 'error') onError = callback; }, unref() {} }),
      },
    );
    onError(Object.assign(new Error(code), { code }));
    assert.match(writes.join(''), new RegExp(`SPAWN_ERROR=${code}\\n${marker}`));
  }
});

test('opencode does not label a synchronous Windows EFTYPE as not found', () => {
  assert.throws(() => startOpencode(
    { prompt: 'full brief', dir: String.raw`C:\work`, logPath: String.raw`C:\state\deep.log`, executable: String.raw`C:\bad.exe` },
    {
      closeSync() {},
      openSync: () => 8,
      platform: 'win32',
      spawn: () => { throw Object.assign(new Error('spawn EFTYPE'), { code: 'EFTYPE' }); },
    },
  ), /opencode failed to start: EFTYPE/);
});

test('Windows resolves an npm cmd shim to Node and round-trips free text without cmd.exe', () => {
  let launch;
  const prompt = String.raw`line one
line "two" \\" tail\\
%PATH:x=y% ! ^`;
  startOpencode(
    { prompt, dir: String.raw`C:\work`, logPath: String.raw`C:\state\deep.log`, executable: String.raw`C:\Program Files\OpenCode\opencode.cmd` },
    {
      closeSync() {},
      env: { COMSPEC: String.raw`Z:\missing\cmd.exe` },
      openSync: () => 8,
      platform: 'win32',
      resolveCommandShim: () => ({ executable: process.execPath, args: ['/resolved/opencode.js'] }),
      setTimeout: () => 7,
      spawn: (...args) => { launch = args; return { pid: 44, once() {}, unref() {} }; },
    },
  );
  assert.equal(launch[0], process.execPath);
  assert.deepEqual(launch[1], ['/resolved/opencode.js', 'run', '--auto', '--dir', String.raw`C:\work`, prompt]);
  assert.equal(launch[2].shell, false);
  assert.equal(launch[2].windowsVerbatimArguments, undefined);
});

test('npm cmd shim resolution selects its Node script without invoking COMSPEC', () => {
  const executable = String.raw`C:\tools\opencode.cmd`;
  const shim = '@ECHO off\r\n"%_prog%" "%dp0%\\..\\opencode-ai\\bin\\opencode" %*\r\n';
  assert.deepEqual(
    resolveWindowsCommandShim(executable, () => shim, String.raw`C:\nodejs\node.exe`),
    {
      executable: String.raw`C:\nodejs\node.exe`,
      args: [String.raw`C:\opencode-ai\bin\opencode`],
    },
  );
});

test('a spawn error arriving after exit cannot append after the terminal marker', () => {
  let onExit;
  let onError;
  const writes = [];
  startOpencode(
    { prompt: 'full brief', dir: '/work', logPath: '/state/deep-1.log' },
    {
      appendFileSync: (_path, value) => writes.push(value),
      closeSync() {},
      openSync: () => 8,
      setTimeout: () => 7,
      spawn: () => ({
        pid: 44,
        once(event, callback) {
          if (event === 'exit') onExit = callback;
          if (event === 'error') onError = callback;
        },
        unref() {},
      }),
    },
  );
  onExit(0);
  onError(Object.assign(new Error('late'), { code: 'EACCES' }));
  assert.deepEqual(writes, ['\nEXIT=0\n']);
});

test('opencode timeout is owned by Node, kills the child, and records the timeout', () => {
  let onExit;
  let onTimeout;
  const signals = [];
  const writes = [];
  const child = {
    pid: 44,
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
      platform: 'linux',
      processFamilyExists: () => false,
      signalProcessFamily: (pid, signal) => signals.push([pid, signal]),
      setTimeout: (callback) => { onTimeout = callback; return 7; },
      spawn: () => child,
    },
  );

  onTimeout();
  onExit(null, 'SIGTERM');
  assert.deepEqual(signals, [[44, 'SIGTERM']]);
  assert.deepEqual(writes, ['\nTIMEOUT=90000\nEXIT=124\n']);
});

test('opencode timeout escalates to SIGKILL and withholds the marker until the family is gone', () => {
  const timers = [];
  const signals = [];
  const writes = [];
  const familyStates = [true, false];
  startOpencode(
    { prompt: 'full brief', dir: '/work', logPath: '/state/deep-1.log', timeoutMs: 90_000 },
    {
      appendFileSync: (_path, value) => writes.push(value),
      clearTimeout() {},
      closeSync() {},
      openSync: () => 8,
      platform: 'linux',
      processFamilyExists: () => familyStates.shift(),
      setTimeout: (callback) => { timers.push(callback); return timers.length; },
      signalProcessFamily: (pid, signal) => signals.push([pid, signal]),
      spawn: () => ({ pid: 44, once() {}, unref() {} }),
    },
  );

  timers.shift()();
  assert.deepEqual(writes, []);
  timers.shift()();
  assert.deepEqual(signals, [[44, 'SIGTERM'], [44, 'SIGKILL']]);
  assert.deepEqual(writes, []);
  timers.shift()();
  assert.deepEqual(writes, ['\nTIMEOUT=90000\nEXIT=124\n']);
});

test('Windows timeout forces the process tree when it has not exited after graceful taskkill', () => {
  let onExit;
  const timers = [];
  const signals = [];
  const writes = [];
  startOpencode(
    { prompt: 'full brief', dir: String.raw`C:\work`, logPath: String.raw`C:\state\deep-1.log`, timeoutMs: 90_000 },
    {
      appendFileSync: (_path, value) => writes.push(value),
      clearTimeout() {},
      closeSync() {},
      openSync: () => 8,
      platform: 'win32',
      setTimeout: (callback) => { timers.push(callback); return timers.length; },
      signalProcessFamily: (pid, signal) => { signals.push([pid, signal]); return true; },
      spawn: () => ({
        pid: 44,
        once(event, callback) { if (event === 'exit') onExit = callback; },
        unref() {},
      }),
    },
  );

  timers.shift()();
  timers.shift()();
  assert.deepEqual(signals, [[44, 'SIGTERM'], [44, 'SIGKILL']]);
  assert.deepEqual(writes, []);
  onExit(null, 'SIGKILL');
  assert.deepEqual(writes, ['\nTIMEOUT=90000\nEXIT=124\n']);
});

test('opencode timeout terminates the real detached child and grandchild before recording exit', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'deep-search-process-tree-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'process-tree.mjs');
  const pidFile = join(root, 'pids');
  const logPath = join(root, 'opencode.log');
  await writeFile(fixture, [
    "import { spawn } from 'node:child_process';",
    "import { writeFileSync } from 'node:fs';",
    'const grandchild = spawn(process.execPath, [\'-e\', \'setInterval(() => {}, 1000)\'], { stdio: \'ignore\' });',
    'writeFileSync(process.argv[2], `${process.pid} ${grandchild.pid}`);',
    'setInterval(() => {}, 1000);',
  ].join('\n'));

  const result = startOpencode(
    { prompt: 'full brief', dir: root, logPath, timeoutMs: 100 },
    {
      spawn: (_command, _args, options) => spawn(process.execPath, [fixture, pidFile], options),
      terminationGraceMs: 100,
    },
  );
  let grandchildPid = 0;
  try {
    assert.equal(await waitFor(async () => {
      try {
        const pids = (await readFile(pidFile, 'utf8')).split(' ').map(Number);
        grandchildPid = pids[1];
        return pids[0] === result.pid && Number.isInteger(grandchildPid);
      } catch { return false; }
    }), true);
    assert.equal(await waitFor(async () => (await readFile(logPath, 'utf8')).includes('EXIT=124')), true);
    assert.throws(() => process.kill(result.pid, 0), { code: 'ESRCH' });
    assert.throws(() => process.kill(grandchildPid, 0), { code: 'ESRCH' });
  } finally {
    try { process.kill(-result.pid, 'SIGKILL'); } catch {}
  }
});

// The real worker (bin/deep.mjs) starts opencode and then has nothing else keeping it alive: the
// child is unref'd, so the timeout itself must keep the worker process running until the run is
// bounded. An unref'd timeout lets the worker exit at once, the timeout never fires, and the
// detached opencode run is left unbounded with no terminal marker.
test('opencode timeout keeps a worker that returns immediately alive until the run is bounded', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'deep-search-worker-alive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const fixture = join(root, 'long-child.mjs');
  const worker = join(root, 'worker.mjs');
  const pidFile = join(root, 'pid');
  const logPath = join(root, 'opencode.log');
  await writeFile(fixture, "import { writeFileSync } from 'node:fs'; writeFileSync(process.argv[2], String(process.pid)); setInterval(() => {}, 1000);");
  const moduleUrl = new URL('../src/deep/opencode.js', import.meta.url).href;
  await writeFile(worker, [
    "import { spawn } from 'node:child_process';",
    `import { startOpencode } from ${JSON.stringify(moduleUrl)};`,
    `startOpencode({ prompt: 'p', dir: ${JSON.stringify(root)}, logPath: ${JSON.stringify(logPath)}, timeoutMs: 200 }, {`,
    `  spawn: (_c, _a, options) => spawn(process.execPath, [${JSON.stringify(fixture)}, ${JSON.stringify(pidFile)}], options),`,
    '  terminationGraceMs: 100,',
    '});',
  ].join('\n'));
  const workerProcess = spawn(process.execPath, [worker], { stdio: 'ignore' });
  await new Promise((resolveExit) => workerProcess.once('exit', resolveExit));
  let childPid = 0;
  try {
    assert.equal(await waitFor(async () => {
      try { childPid = Number(await readFile(pidFile, 'utf8')); return childPid > 0; } catch { return false; }
    }), true);
    assert.equal(await waitFor(async () => (await readFile(logPath, 'utf8')).includes('EXIT=124'), 2_000), true);
    assert.throws(() => process.kill(childPid, 0), { code: 'ESRCH' });
  } finally {
    if (childPid) try { process.kill(-childPid, 'SIGKILL'); } catch {}
  }
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
