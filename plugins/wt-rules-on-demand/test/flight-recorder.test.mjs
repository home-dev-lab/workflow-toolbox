import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, resetForSelftest } from '../hooks/hooks.js';
import { scanPlan, scanTranscript, announcement } from '../scripts/unload-watch-lib.mjs';
import { STORE_BUDGETS } from '../hooks/store-budget.js';
import * as recorder from '../hooks/flight-recorder.js';

const { mergeFlightHealth } = recorder;

const directory = '/fixture/config/plugins/data/wt-rules-on-demand/inflight';
const inflight = (path) => path.startsWith(`${directory}/`);
const breadcrumbs = (s) => [...s.files].filter(([path]) => inflight(path));

const hookNames = ['prompt.context', 'prompt.submit', 'tool.call', 'turn.complete', 'session.compact'];
const never = () => new Promise(() => {});
const tick = () => new Promise(setImmediate);
function signalled(next, signal) { next.signal = signal; return next; }
async function settles(pending, message) {
  let timer;
  try {
    const result = await Promise.race([pending.then((value) => ({ settled: true, value })),
      new Promise((resolve) => { timer = setTimeout(() => resolve({ settled: false }), 200); })]);
    assert.equal(result.settled, true, message);
    return result.value;
  } finally { clearTimeout(timer); }
}
class CountingSignal extends EventTarget {
  aborted = false;
  listeners = new Set();
  addEventListener(type, listener, options) {
    if (type === 'abort') this.listeners.add(listener);
    super.addEventListener(type, listener, options);
  }
  removeEventListener(type, listener, options) {
    if (type === 'abort') this.listeners.delete(listener);
    super.removeEventListener(type, listener, options);
  }
  abort() { this.aborted = true; this.dispatchEvent(new Event('abort')); }
}

async function warmFixture($, handlers, calls, logs, stored) {
  // Resolve both inputs through real engine loading/journaling, then reset the cold recorder.
  // Snapshot capabilities so a test's deferred/throwing instrument applies to its event, not this warm-up.
  const host = { ...$, env: { ...$.env }, session: { ...$.session }, fs: { ...$.fs }, ui: { ...$.ui }, store: { ...$.store } };
  const list = host.fs.list, read = host.fs.read;
  host.fs.list = (path) => {
    if (path === directory) return [];
    if (path === '/fixture/config/rules-on-demand') return [{ name: 'warm.md', kind: 'file' }];
    return list(path);
  };
  host.fs.read = (path) => path === '/fixture/config/rules-on-demand/warm.md'
    ? '---\non-demand:\n  triggers:\n    - kind: tool\n      tool: "^Agent$"\n      unconditional: true\n  compliance:\n    kind: none\n    reason: fixture\n---\nWarm rule.\n' : read(path);
  await handlers.get('tool.call')(host, { cwd: '/fixture', tool: 'Agent' }, async () => ({}));
  await new Promise(setImmediate);
  resetForSelftest(true);
  calls.length = 0;
  logs.length = 0;
  stored.clear();
  return host;
}

async function bootstrapFixture($, host, handlers) {
  await handlers.get('session.compact')({ ...host, fs: $.fs, ui: $.ui }, {}, async () => ({}));
  // Only fixture preparation yields for background diagnostics; serving hooks do not.
  await new Promise(setImmediate);
}

function fixture({ enabled = true, session = 'fixture/session', files = new Map(), prime = true } = {}) {
  const handlers = new Map(), calls = [], logs = [], stored = new Map();
  let primed = false;
  resetForSelftest();
  register((name, handler) => handlers.set(name, handler), { enabled });
  const $ = {
    env: { get: async (name) => name === 'CLAUDE_CONFIG_DIR' ? '/fixture/config' : null },
    session: { id: async () => session, root: async () => '/fixture', messages: async () => [] },
    ui: { log: (line) => { logs.push(line); } },
    store: { get: async (name) => stored.get(name), set: async (name, value) => {
      calls.push({ op: 'store', name, phases: breadcrumbs({ files }).map(([, text]) => JSON.parse(text).phase) });
      stored.set(name, structuredClone(value));
    } },
    fs: {
      write: async (path, text) => { calls.push({ op: 'write', path, row: JSON.parse(text) }); files.set(path, text); },
      list: async (path) => {
        calls.push({ op: 'list', path });
        return [...files.keys()].filter((file) => file.startsWith(`${path}/`)).map((file) => ({ name: file.slice(path.length + 1), kind: 'file' }));
      },
      read: async (path) => {
        calls.push({ op: 'read', path });
        if (!files.has(path)) throw hostFailure('read', path, 'ENOENT');
        return files.get(path);
      },
      stat: async () => ({ kind: 'dir' }),
      exists: async (path) => files.has(path),
      ancestors: async () => [],
    },
  };
  const ready = enabled ? warmFixture($, handlers, calls, logs, stored) : Promise.resolve();
  const event = async (name = 'session.compact', input = {}, next = async () => ({ answer: 42 })) => {
    const host = await ready;
    if (enabled && prime && !primed && !next.signal?.aborted) { primed = true; await bootstrapFixture($, host, handlers); }
    try { return await handlers.get(name)($, input, next); }
    finally { await new Promise(setImmediate); }
  };
  return { $, event, files, calls, logs, stored };
}

function clock(t) {
  const RealDate = Date;
  let now = Date.parse('2026-01-10T12:00:00.000Z');
  class ClockDate extends RealDate {
    constructor(...args) { super(...(args.length ? args : [now])); }
    static now() { return now; }
  }
  globalThis.Date = ClockDate;
  t.after(() => { globalThis.Date = RealDate; });
  return { advance: (ms) => { now += ms; } };
}

for (const work of hookNames) {
  test(`abort settles ${work} during a never-settling store operation`, async () => {
    const s = fixture({ prime: false }), entered = deferred(), controller = new AbortController();
    for (let i = 0; i < 49; i++) await s.event('tool.call', { tool: 'Agent', cwd: '/fixture' });
    for (const name of ['get', 'set', 'keys']) s.$.store[name] = () => { entered.resolve(); return never(); };
    const pending = s.event(work, { tool: 'Agent', cwd: '/fixture' }, signalled(async () => ({}), controller.signal));
    await entered.promise;
    controller.abort();
    await settles(pending, `${work} must settle within 200 ms of abort while store I/O never settles`);
  });
  test(`abort settles ${work} waiting for the write turn without releasing it`, async (t) => {
    const time = clock(t), s = fixture(), entered = deferred(), controller = new AbortController();
    let reads = 0;
    s.$.store.get = () => { reads++; entered.resolve(); return never(); };
    void s.event('turn.complete');
    await entered.promise;
    time.advance(60_001);
    const pending = s.event(work, { tool: 'Agent', cwd: '/fixture' }, signalled(async () => ({}), controller.signal));
    await tick();
    assert.equal(reads, 1, 'the target must wait behind the held write turn');
    controller.abort();
    await settles(pending, `${work} must settle within 200 ms of abort while the write turn never settles`);
    await tick();
    assert.equal(reads, 1, 'abandonment must not release the detached body\'s write turn');
  });
  test(`already-aborted ${work} settles without starting work`, async () => {
    const s = fixture(), controller = new AbortController();
    let called = false, started = 0;
    s.$.env.get = () => { started++; return never(); };
    controller.abort();
    const next = signalled(async () => { called = true; return {}; }, controller.signal);
    await settles(s.event(work, {}, next), `${work} must settle at entry when its signal is already aborted`);
    assert.equal(called, false, 'already-aborted hooks must not call downstream');
    assert.equal(started, 0, 'already-aborted hooks must not start their body');
    assert.equal(s.calls.length, 0, 'already-aborted hooks must not start recorder I/O');
  });
  test(`normal ${work} keeps its answer and removes abort listeners across repeated calls`, async () => {
    const s = fixture(), signal = new CountingSignal();
    for (let i = 0; i < 20; i++) {
      const answer = { answer: i }, entered = deferred(), held = deferred();
      const pending = s.event(work, {}, signalled(async () => { entered.resolve(); return held.promise; }, signal));
      await entered.promise;
      const listeners = signal.listeners.size;
      held.resolve(answer);
      assert.equal(await pending, answer, `${work} must preserve its downstream answer without abort`);
      assert.equal(listeners, 1, 'a running signalled hook must install one abort listener');
      assert.equal(signal.listeners.size, 0, 'a normally settled hook must remove its abort listener');
    }
  });
}

for (const rejects of [false, true]) {
  test(`aborted body stays recorded until its late ${rejects ? 'rejection' : 'completion'}`, async () => {
    const s = fixture(), controller = new AbortController(), held = deferred(), entered = deferred();
    const unhandled = [];
    const observe = (error) => unhandled.push(error);
    process.on('unhandledRejection', observe);
    try {
      const pending = s.event('session.compact', {}, signalled(async () => { entered.resolve(); return held.promise; }, controller.signal));
      await entered.promise;
      const [path] = breadcrumbs(s)[0];
      controller.abort();
      await settles(pending, 'aborted hook must settle while its recorded body is still running');
      assert.equal(JSON.parse(s.files.get(path)).phase, 'work', 'abort must not confirm or release the running slot');
      await s.event('session.compact');
      assert.equal(breadcrumbs(s).length, 2, 'another call must not reuse the detached body\'s slot');
      if (rejects) held.reject(new Error('late detached failure'));
      else held.resolve({ answer: 42 });
      for (let i = 0; i < 20 && JSON.parse(s.files.get(path)).phase !== 'complete'; i++) await tick();
      assert.deepEqual(s.calls.filter((call) => call.path === path && call.op === 'write').map((call) => call.row.phase),
        ['work', 'finally', 'complete'], 'detached bodies must write their real finally and completion phases');
      await tick();
      assert.deepEqual(unhandled, [], 'late detached rejection must never become unhandled');
    } finally { process.removeListener('unhandledRejection', observe); }
  });
}

test('aborted never-ending body remains unconfirmed and is named after reload', async () => {
  const old = fixture(), entered = deferred(), controller = new AbortController();
  const pending = old.event('tool.call', { tool: 'Bash', input: { command: 'abc' } },
    signalled(async () => { entered.resolve(); return never(); }, controller.signal));
  await entered.promise;
  const [path, text] = breadcrumbs(old)[0];
  controller.abort();
  await settles(pending, 'aborted never-ending body must release the host-facing hook');
  assert.equal(old.files.get(path), text, 'abort must leave the never-ending body unconfirmed');
  const s = fixture({ files: old.files });
  await s.event('turn.complete');
  assert.ok(s.logs.some((line) => line.includes('call did not confirm completion: tool.call (Bash), last phase work')),
    'reload must name the body that never confirmed completion');
  assert.ok(s.stored.get('health').interruptedCalls.some((call) => call.path === path));
});

test('disabled hooks also settle on abort without waiting for downstream', async () => {
  const s = fixture({ enabled: false }), controller = new AbortController(), entered = deferred();
  const pending = s.event('session.compact', {}, signalled(async () => { entered.resolve(); return never(); }, controller.signal));
  await entered.promise;
  controller.abort();
  await settles(pending, 'disabled hooks must obey the host abort signal too');
  assert.deepEqual(s.calls, []);
});

test('abort during recorder preparation settles and leaves the body detached', async () => {
  const s = fixture(), controller = new AbortController(), entered = deferred();
  s.$.session.root = never;
  const input = { get agentId() {
    if (new Error().stack.includes('toolCallWork')) { controller.abort(); entered.resolve(); }
    return 'helper';
  } };
  const pending = s.event('tool.call', input, signalled(async () => ({}), controller.signal));
  await entered.promise;
  await settles(pending, 'abort during body startup must settle even before the listener is installed');
});

test('normal rejection is preserved and removes the abort listener', async () => {
  const s = fixture(), signal = new CountingSignal(), failure = new Error('normal downstream failure');
  await assert.rejects(s.event('session.compact', {}, signalled(async () => { throw failure; }, signal)),
    (error) => error === failure);
  assert.equal(signal.listeners.size, 0, 'a normally rejected hook must remove its abort listener');
});

for (const throws of [false, true]) {
  test(`breadcrumb dispatch precedes work, enters finally and completes on ${throws ? 'throw' : 'success'}`, async (t) => {
    const time = clock(t), s = fixture(), failure = new Error('downstream failed');
    const promise = s.event('session.compact', { agentId: 'helper' }, async () => {
      const entries = s.calls.filter((call) => call.op === 'write');
      assert.equal(entries.length, 1, 'one breadcrumb write must be dispatched before work runs');
      const { path, row } = entries[0];
      assert.match(path.slice(directory.length + 1), /^[A-Za-z0-9._-]+\.json$/);
      assert.equal(row.work, 'session.compact');
      assert.equal(row.phase, 'work');
      assert.equal(row.agentId, 'helper');
      assert.equal(row.sessionId, 'fixture/session');
      assert.ok(row.loadToken);
      assert.equal(row.startedAt, new Date().toISOString());
      time.advance(60_001);
      if (throws) throw failure;
      return { answer: 42 };
    });
    if (throws) await assert.rejects(promise, (error) => error === failure);
    else assert.deepEqual(await promise, { answer: 42 });
    assert.deepEqual(s.calls.filter((call) => call.op === 'write').map((call) => call.row.phase), ['work', 'finally', 'complete']);
    assert.ok(s.calls.some((call) => call.op === 'store' && call.name === 'health' && call.phases[0] === 'finally'));
    assert.equal(JSON.parse(breadcrumbs(s)[0][1]).phase, 'complete', 'completed slots must not remain in flight');
  });
}

test('every registered event records its work and tool input is measured only one level deep', async () => {
  const s = fixture();
  const input = { command: 'abcd', description: 'xy', nested: { text: 'ignored' } };
  for (const work of ['prompt.context', 'prompt.submit', 'tool.call', 'turn.complete', 'session.compact']) {
    await s.event(work, { tool: 'Bash', input, prompt: 'ignored when input exists' }, async () => {
      const row = s.calls.filter((call) => call.op === 'write' && call.row.phase === 'work').at(-1).row;
      assert.equal(row.work, work);
      assert.equal(row.tool, work === 'tool.call' ? 'Bash' : '');
      assert.equal(row.inputChars, 6);
      return {};
    });
  }
  await s.event('session.compact', { input: { ...input, toJSON() { throw new Error('must not serialize input'); } } });
  await s.event('tool.call', { tool: 'Bash', input: { command: 'x'.repeat(2_000_000) } }, async () => {
    assert.equal(s.calls.filter((call) => call.op === 'write' && call.row.phase === 'work').at(-1).row.inputChars, 1_000_000);
    return {};
  });
});

test('concurrent events have distinct files and list the directory once per load', async () => {
  const s = fixture();
  let release, entered;
  const hold = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  const first = s.event('session.compact', { agentId: 'one' }, async () => { entered(); await hold; return {}; });
  await ready;
  await s.event('session.compact', { agentId: 'two' }, async () => {
    const entries = s.calls.filter((call) => call.op === 'write' && call.row.phase === 'work');
    assert.equal(entries.length, 2, 'both entry writes must be dispatched before the second body runs');
    assert.equal(new Set(entries.map(({ path }) => path)).size, 2);
    return {};
  });
  release();
  await first;
  assert.equal(s.calls.filter((call) => call.op === 'list' && call.path === directory).length, 1);
  assert.ok(breadcrumbs(s).every(([, text]) => JSON.parse(text).phase === 'complete'));
});

// Own-session slots share the abandoned slot's session key; only the index differs.
const slotPath = (path, index) => path.replace(/-\d+\.json$/, () => `-${index}.json`);

async function abandoned(s, work = 'tool.call') {
  let saved;
  await s.event(work, { tool: 'Bash', agentId: 'helper', input: { command: 'abc' } }, async () => {
    const { path, row } = s.calls.filter((call) => call.op === 'write' && call.row.phase === 'work').at(-1);
    saved = [path, JSON.stringify(row)];
    return {};
  });
  s.files.set(...saved);
  return saved;
}

test('reload batches same-session leftovers for normal health flush and logs details', async () => {
  const old = fixture(), [path, text] = await abandoned(old);
  const s = fixture({ files: old.files });
  await s.event('turn.complete');
  const row = JSON.parse(text), health = s.stored.get('health');
  assert.deepEqual(health?.interruptedCalls, [{ ...row, path }], 'health must retain the interrupted call after reload');
  assert.ok(s.calls.some((call) => call.op === 'write' && call.path === path && call.row.phase === 'harvested'));
  assert.equal(s.logs.length, 1);
  for (const word of ['call did not confirm completion', 'tool.call', 'Bash', 'work', '3 input chars']) assert.ok(s.logs[0].includes(word));
  assert.ok(s.logs[0].includes(row.startedAt));
  const fresh = s.calls.find((call) => call.op === 'write' && call.row.phase === 'work').row;
  assert.notEqual(fresh.loadToken, row.loadToken);
  await s.event();
  assert.equal(s.logs.length, 1);
  assert.equal(s.calls.filter((call) => call.op === 'list' && call.path === directory).length, 1);
});

test('other sessions survive harvest even when breadcrumbs are older than seven days', async (t) => {
  const time = clock(t), old = fixture({ session: 'other' }), [freshPath, text] = await abandoned(old);
  const expiredPath = `${directory}/expired.json`, stale = JSON.parse(text);
  stale.startedAt = '2026-01-03T11:59:59.999Z';
  old.files.set(expiredPath, JSON.stringify(stale));
  const s = fixture({ files: old.files });
  await s.event();
  assert.equal(s.files.has(freshPath), true);
  assert.equal(s.files.get(expiredPath), JSON.stringify(stale));
  assert.equal(s.logs.length, 0);
  time.advance(8 * 86_400_000);
  await s.event();
  assert.equal(s.files.has(freshPath), true, 'cleanup lists once per load');
});

test('first-load harvest reads only this session\'s slots, never other sessions\' files', async () => {
  const other = fixture({ session: 'other' }), [otherPath] = await abandoned(other);
  other.files.set(`${directory}/unrelated.json`, '{}');
  const s = fixture({ files: other.files });
  await s.event();
  const reads = s.calls.filter((call) => call.op === 'read').map((call) => call.path);
  assert.deepEqual(reads.filter((path) => path === otherPath || path.endsWith('/unrelated.json')), [],
    'a first event must not pay one host read per file of every other session');
});

test('interrupted history retains only the twenty newest calls', async () => {
  const old = fixture(), [path, text] = await abandoned(old), row = JSON.parse(text);
  old.files.clear();
  for (let index = 0; index < 25; index++) {
    old.files.set(slotPath(path, index), JSON.stringify({ ...row, startedAt: `2026-01-01T00:00:${String(index).padStart(2, '0')}.000Z` }));
  }
  const s = fixture({ files: old.files });
  await s.event('turn.complete');
  assert.equal(s.stored.get('health')?.interruptedCalls.length, 20);
  assert.equal(s.stored.get('health').interruptedCalls[0].startedAt, '2026-01-01T00:00:05.000Z');
  assert.equal(s.logs.length, 25);
  assert.ok(breadcrumbs(s).every(([, text]) => ['complete', 'harvested'].includes(JSON.parse(text).phase)));
});

test('slowest calls keep the top ten wall times, persist across flushes and reset each UTC day', async (t) => {
  const time = clock(t), s = fixture();
  for (let ms = 1; ms <= 15; ms++) {
    await s.event('session.compact', { input: { text: 'abc' } }, async () => { time.advance(ms); return {}; });
  }
  await s.event('turn.complete');
  assert.deepEqual(s.stored.get('health')?.slowestCalls.map((row) => row.ms), [15, 14, 13, 12, 11, 10, 9, 8, 7, 6]);
  assert.deepEqual(Object.keys(s.stored.get('health').slowestCalls[0]).sort(), ['at', 'inputChars', 'ms', 'tool', 'work']);
  assert.equal(s.stored.get('health').slowestCalls[0].inputChars, 3);
  await s.event('turn.complete');
  assert.equal(s.stored.get('health').slowestCalls[0].ms, 15);
  time.advance(86_400_000);
  await s.event('turn.complete', {}, async () => { time.advance(2); return {}; });
  assert.deepEqual(s.stored.get('health').slowestCalls.map((row) => row.ms), [2]);
});

for (const method of ['write', 'list', 'read']) {
  for (const missing of [true, false]) {
    test(`fs.${method} ${missing ? 'missing' : 'throwing'} preserves results and thrown errors`, async () => {
      const old = fixture();
      await abandoned(old);
      const s = fixture({ files: old.files });
      if (missing) delete s.$.fs[method];
      else s.$.fs[method] = async (path) => { throw hostFailure(method, path); };
      const result = { deny: 'fixture refusal' }, failure = new Error('fixture downstream error');
      assert.equal(await s.event('session.compact', {}, async () => result), result);
      await assert.rejects(s.event('session.compact', {}, async () => { throw failure; }), (error) => error === failure);
    });
  }
}

test('disabled recorder makes no host calls', async () => {
  const s = fixture({ enabled: false });
  await s.event();
  assert.deepEqual(s.calls, []);
  assert.deepEqual(s.logs, []);
});

test('unconfirmed harvest progress is alive evidence for the unload detector', () => {
  const timestamp = '2026-01-10T12:00:00.000Z';
  const rows = [
    { content: 'wt-rules-on-demand: wt-rules-on-demand was unloaded: it crashed the hooks worker', timestamp: '2026-01-10T11:59:00.000Z' },
    { content: 'wt-rules-on-demand: wt-rules-on-demand: call did not confirm completion: tool.call (Bash), last phase work, 3 input chars, started at 2026-01-10T11:58:00.000Z', timestamp },
  ];
  const bytes = Buffer.from(rows.map((row) => JSON.stringify({ type: 'system', subtype: 'informational', ...row }) + '\n').join(''));
  const state = scanTranscript(bytes, scanPlan(bytes.length, null));
  assert.equal(state.aliveAt, timestamp, 'harvest progress must prove the engine is alive');
  assert.equal(announcement(state, { hook_event_name: 'UserPromptSubmit' }, timestamp).output, null);
});

test('first-load harvest finishes reading before any breadcrumb can overwrite a slot', async () => {
  const s = fixture({ prime: false });
  let release, entered;
  const hold = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  s.$.fs.list = async (path) => { if (path === directory) { entered(); return hold; } return []; };
  const result = { deny: 'fixture refusal' };
  const pending = s.event('session.compact', {}, async () => result);
  await ready;
  assert.equal(s.calls.some((call) => call.op === 'write'), false, 'harvest must precede the first slot write');
  assert.equal(await within(pending, 100, 'a hook must return without waiting for its cold harvest scan'), result);
  assert.equal(breadcrumbs(s).length, 0, 'a call before setup finishes must remain unrecorded');
  release([]);
  await new Promise(setImmediate);
  await s.event('session.compact', {}, async () => result);
  assert.equal(breadcrumbs(s).length, 1, 'a later event must record once the background scan finishes');
  assert.deepEqual(s.logs, []);
});

test('failed normal health flush retains pending harvested rows for a later normal flush', async () => {
  const old = fixture(), [path, text] = await abandoned(old), s = fixture({ files: old.files });
  const save = s.$.store.set;
  s.$.store.set = async () => { throw new Error('health unavailable'); };
  assert.deepEqual(await s.event('turn.complete'), { answer: 42 });
  assert.equal(s.stored.has('health'), false);
  s.$.store.set = save;
  assert.deepEqual(await s.event('turn.complete'), { answer: 42 });
  assert.deepEqual(s.stored.get('health').interruptedCalls, [{ ...JSON.parse(text), path }],
    'a failed engine flush must retain the pending harvested rows');
});

test('failed breadcrumb writes still retain completed-call timing', async (t) => {
  const time = clock(t), s = fixture();
  s.$.fs.write = async (path) => { throw hostFailure('write', path); };
  await s.event('turn.complete', {}, async () => { time.advance(25); return {}; });
  assert.equal(s.stored.get('health').slowestCalls[0].ms, 25);
  assert.equal(breadcrumbs(s).length, 0);
});

test('full recorder histories and existing counter/error histories fit the unchanged health budget', async (t) => {
  clock(t);
  const old = fixture({ session: 's'.repeat(512) });
  const [path, text] = await abandoned(old), row = JSON.parse(text);
  old.files.delete(path);
  for (let index = 0; index < 20; index++) {
    old.files.set(slotPath(path, index), JSON.stringify({ ...row, tool: '"'.repeat(160), agentId: '"'.repeat(128) }));
  }
  const s = fixture({ session: row.sessionId, files: old.files });
  s.stored.set('health', { days: Object.fromEntries(Array.from({ length: 31 }, (_, i) => [`2025-12-${String(i + 1).padStart(2, '0')}`,
    { calls: 100, errors: 20, totalMs: 99999, maxMs: 1000, slow: 10 }])),
  lastErrors: Array.from({ length: 20 }, () => ({ at: new Date().toISOString(), message: '"'.repeat(160) })) });
  for (let index = 0; index < 10; index++) await s.event('tool.call', { tool: '"'.repeat(160) });
  await s.event('turn.complete');
  const health = s.stored.get('health');
  assert.equal(health.interruptedCalls.length, 20);
  assert.equal(health.slowestCalls.length, 10);
  assert.ok(JSON.stringify(health).length < STORE_BUDGETS.health);
  assert.equal(STORE_BUDGETS.health, 50_000);
});

test('recorder never accesses a removal method on the host', async () => {
  const old = fixture();
  await abandoned(old);
  const s = fixture({ files: old.files }), removals = [];
  s.$.fs = new Proxy(s.$.fs, { get(target, name) {
    if (['remove', 'unlink', 'rm'].includes(name)) removals.push(name);
    return Reflect.get(target, name);
  } });
  await s.event();
  assert.deepEqual(removals, [], 'recorder must never access a removal method');
});

test('harvested slots cannot be reported again on later reloads', async () => {
  const old = fixture(), [path] = await abandoned(old);
  const s = fixture({ files: old.files });
  // Leave the harvested slot untouched by this load's event, isolating the marking lock.
  const write = s.$.fs.write;
  s.$.fs.write = async (file, text) => {
    if (JSON.parse(text).phase === 'harvested') await write(file, text);
  };
  await s.event();
  assert.equal(s.logs.length, 1);
  assert.equal(JSON.parse(s.files.get(path)).phase, 'harvested', 'harvest must mark its slot as already reported');
  const nextLoad = fixture({ files: s.files });
  await nextLoad.event();
  assert.deepEqual(nextLoad.logs, [], 'a successfully marked slot must not be reported again');
});

test('slowest calls are capped at exactly ten even in a single large batch', () => {
  const health = {}, at = new Date().toISOString();
  mergeFlightHealth(health, { slowestCalls: Array.from({ length: 11 }, (_, ms) => ({ work: 'tool.call', tool: 'Bash', ms, inputChars: 1, at })) });
  assert.equal(health.slowestCalls.length, 10, 'slowest calls must retain exactly ten rows');
  assert.deepEqual(health.slowestCalls.map((row) => row.ms), [10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
});

test('slot file count stays bounded across many completed events and reloads', async () => {
  assert.equal(recorder.MAX_CONCURRENT_FLIGHTS, 32);
  const files = new Map();
  for (let load = 0; load < 5; load++) {
    const s = fixture({ files });
    for (let event = 0; event < 70; event++) await s.event();
    assert.ok(breadcrumbs(s).length <= 32, 'a session must create no more than 32 slot files');
    assert.deepEqual(s.logs, [], 'completed slots must not be harvested');
  }
});

test('saturated concurrent slots never overwrite active events and become reusable on completion', async () => {
  const s = fixture();
  let release;
  const hold = new Promise((resolve) => { release = resolve; }), events = [];
  try {
    for (let index = 0; index < 32; index++) {
      let entered;
      const ready = new Promise((resolve) => { entered = resolve; });
      events.push(s.event('session.compact', { agentId: `agent-${index}` }, async () => { entered(); await hold; return {}; }));
      await ready;
    }
    const active = breadcrumbs(s);
    assert.equal(active.length, 32);
    assert.deepEqual(await s.event(), { answer: 42 });
    assert.deepEqual(breadcrumbs(s), active, 'overflow must leave all active slots untouched');
  } finally { release(); await Promise.all(events); }
  await s.event();
  assert.equal(breadcrumbs(s).length, 32);
  assert.ok(breadcrumbs(s).every(([, text]) => JSON.parse(text).phase === 'complete'));
});

test('session ids that sanitize alike still have distinct bounded slot filenames', async () => {
  const first = fixture({ session: 'fixture/session' });
  const [path, text] = await abandoned(first);
  const second = fixture({ session: 'fixture_session', files: first.files });
  await second.event();
  assert.equal(second.files.get(path), text, 'another session with a sanitized alias must be left alone');
  assert.equal(breadcrumbs(second).length, 2);
});

test('harvest never takes the shared write turn or issues a health store operation', async () => {
  const old = fixture(), [path, text] = await abandoned(old), s = fixture({ files: old.files });
  const hold = deferred(), get = s.$.store.get;
  let workEntered = false, harvestReads = 0;
  s.$.store.get = (name) => {
    if (name === 'health' && !workEntered) { harvestReads++; return hold.promise; }
    return get(name);
  };
  const result = { deny: 'fixture refusal' };
  try {
    assert.equal(await within(s.event('turn.complete', {}, () => { workEntered = true; return result; }),
      650, 'turn.complete return must not depend on a harvest-issued health read'), result);
    assert.equal(harvestReads, 0, 'harvest must issue no health store operation');
    assert.deepEqual(s.stored.get('health').interruptedCalls, [{ ...JSON.parse(text), path }],
      'normal turn completion must persist the pending harvest batch');
  } finally { hold.resolve(); await new Promise(setImmediate); }
});

test('harvest only batches health rows until an engine flush is due', async () => {
  const old = fixture(), [path, text] = await abandoned(old), s = fixture({ files: old.files });
  const get = s.$.store.get, healthReads = [];
  s.$.store.get = async (name) => { if (name === 'health') { healthReads.push(name); } return get(name); };
  await s.event();
  assert.deepEqual(healthReads, [], 'harvest must not read the health store');
  assert.equal(s.calls.some((call) => call.op === 'store'), false, 'harvest must not write the health store');
  assert.equal(s.logs.length, 1, 'the diagnostic line must not wait for health persistence');
  await s.event('turn.complete');
  assert.ok(healthReads.length > 0, 'the engine flush must read health');
  assert.deepEqual(s.stored.get('health').interruptedCalls, [{ ...JSON.parse(text), path }]);
});

for (const op of ['log', 'mark']) {
  test(`a never resolving harvest ${op} cannot delay a hook return`, async () => {
    const old = fixture();
    await abandoned(old);
    const s = fixture({ files: old.files }), hold = deferred(), write = s.$.fs.write;
    if (op === 'log') s.$.ui.log = () => hold.promise;
    else s.$.fs.write = (path, text) => JSON.parse(text).phase === 'harvested' ? hold.promise : write(path, text);
    assert.deepEqual(await within(s.event('turn.complete'), 250, `hook return must not depend on harvest ${op}`), { answer: 42 });
    assert.equal(s.stored.get('health').interruptedCalls.length, 1);
  });
}

// The real host (2.1.292) rethrows a failed $.fs call as `<plugin>: $.fs.<op>(<path>) failed: <errno>`,
// with no `code` property; the node-style shape is kept for older hosts and fixtures.
const missingDirectoryErrors = {
  'host message': (path) => new Error(`wt-rules-on-demand: $.fs.list(${path}) failed: ENOENT`),
  'node error': () => Object.assign(new Error('ENOENT: no such directory'), { code: 'ENOENT' }),
};
for (const [shape, error] of Object.entries(missingDirectoryErrors)) {
  test(`a new session with no inflight directory still records its first event (${shape})`, async () => {
    const s = fixture();
    s.$.fs.list = async (path) => { throw error(path); };
    await s.event('session.compact', {}, async () => {
      assert.equal(s.calls.filter((call) => call.op === 'write' && call.row.phase === 'work').length, 1,
        'a missing inflight directory must not disable entry dispatch');
      return {};
    });
    assert.equal(JSON.parse(breadcrumbs(s)[0][1]).phase, 'complete');
  });
}

const hostFailure = (op, path, errno = 'EIO') => new Error(`wt-rules-on-demand: $.fs.${op}(${path}) failed: ${errno}`);
const deferred = () => {
  let resolve, reject;
  const promise = new Promise((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
};
async function within(promise, ms, message) {
  let timer;
  try {
    return await Promise.race([promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error(message)), ms);
    })]);
  } finally { clearTimeout(timer); }
}

test('never resolving filesystem calls cannot stall a hook', async () => {
  const s = fixture(), hold = deferred();
  for (const op of Object.keys(s.$.fs)) s.$.fs[op] = () => hold.promise;
  assert.deepEqual(await within(s.event(), 650, 'recorder scan exceeded its serving bound'), { answer: 42 });
  assert.equal(breadcrumbs(s).length, 0, 'an unfinished scan must not write a slot');
});

test('entry is dispatched before work and trailing writes never delay return', async () => {
  const s = fixture(), holds = [], phases = [];
  s.$.fs.write = (path, text) => {
    const hold = deferred(), row = JSON.parse(text);
    phases.push(row.phase);
    holds.push(() => { s.files.set(path, text); hold.resolve(); });
    return hold.promise;
  };
  await within(s.event('session.compact', {}, () => {
    assert.deepEqual(phases, ['work'], 'entry must be dispatched before synchronous work');
    assert.deepEqual(breadcrumbs(s), [], 'dispatch must not require the breadcrumb to have landed');
    return { answer: 42 };
  }), 350, 'entry or trailing writes exceeded the serving bound');
  assert.deepEqual(phases, ['work']);
  for (const phase of ['work', 'finally', 'complete']) {
    holds.shift()();
    await new Promise(setImmediate);
    assert.equal(JSON.parse(breadcrumbs(s)[0][1]).phase, phase, 'slot writes must land in phase order');
  }
  assert.deepEqual(phases, ['work', 'finally', 'complete']);
});

test('a timed out scan protects old evidence and later events resume recording', async () => {
  const old = fixture(), [path, text] = await abandoned(old), s = fixture({ files: old.files });
  const hold = deferred(), read = s.$.fs.read;
  s.$.fs.read = async (file) => { await hold.promise; return read(file); };
  await within(s.event(), 650, 'deferred harvest read exceeded the serving bound');
  assert.equal(s.files.get(path), text, 'pending harvest must protect previous evidence');
  assert.equal(s.calls.some((call) => call.op === 'write'), false);
  hold.resolve();
  await new Promise(setImmediate);
  await s.event();
  assert.ok(s.calls.some((call) => call.op === 'write' && call.row.phase === 'work'), 'later events must record after scan completion');
});

test('one failed complete write is retried and creates no reload report', async () => {
  const s = fixture(), write = s.$.fs.write;
  let attempts = 0;
  s.$.fs.write = async (path, text) => {
    if (JSON.parse(text).phase === 'complete' && ++attempts === 1) throw hostFailure('write', path);
    return write(path, text);
  };
  await s.event();
  const next = fixture({ files: s.files });
  await next.event();
  assert.deepEqual(next.logs, [], 'a transient complete failure must not report an interruption');
  assert.equal(attempts, 2, 'complete must retry once');
});

for (const phase of ['work', 'finally']) {
  test(`${phase} harvest says completion is unconfirmed and never claims an interruption`, async () => {
    const old = fixture(), [path, text] = await abandoned(old);
    old.files.set(path, JSON.stringify({ ...JSON.parse(text), phase }));
    const s = fixture({ files: old.files });
    await s.event();
    assert.ok(s.logs[0].startsWith(`wt-rules-on-demand: call did not confirm completion: tool.call (Bash), last phase ${phase},`),
      'every incomplete phase must use the same unconfirmed-completion line shape');
    assert.doesNotMatch(s.logs[0], /interrupt/i, 'no harvest line may claim an interruption');
    assert.equal(s.logs.length, 1);
  });
}

test('announcement failure leaves the slot available to announce after reload', async () => {
  const old = fixture(), [path, text] = await abandoned(old), s = fixture({ files: old.files });
  s.$.ui.log = () => { throw new Error('ui unavailable'); };
  await s.event();
  assert.equal(s.files.get(path), text, 'log must precede the harvested marker');
  const next = fixture({ files: s.files });
  await next.event();
  assert.equal(next.logs.length, 1, 'a failed log must not consume the announcement');
});

test('persist then failed mark then reload retains one health row per slot identity including path', async () => {
  const old = fixture(), [path] = await abandoned(old), s = fixture({ files: old.files });
  const secondPath = slotPath(path, 1);
  s.files.set(secondPath, s.files.get(path));
  const write = s.$.fs.write;
  s.$.fs.write = async (file, text) => {
    if (JSON.parse(text).phase === 'harvested') throw hostFailure('write', file);
    return write(file, text);
  };
  await s.event('turn.complete');
  const next = fixture({ files: s.files });
  next.stored.set('health', structuredClone(s.stored.get('health')));
  await next.event('turn.complete');
  assert.equal(next.stored.get('health').interruptedCalls.length, 2, 'distinct paths must survive re-harvest even with identical loadToken and startedAt');
  assert.deepEqual(next.stored.get('health').interruptedCalls.map((row) => row.path).sort(), [path, secondPath].sort(),
    'identity includes the slot path');
  assert.equal(s.logs.length, 2);
  assert.equal(next.logs.length, 2, 'a failed mark permits duplicate announcements on reload');
});

test('transient listing failure retries on a later event without unsafe writes', async () => {
  const s = fixture({ prime: false }), list = s.$.fs.list;
  let attempts = 0;
  s.$.fs.list = async (path) => {
    if (++attempts === 1) throw hostFailure('list', path);
    return list(path);
  };
  await s.event();
  assert.equal(breadcrumbs(s).length, 0, 'failed scan must not write a slot');
  await s.event();
  assert.equal(breadcrumbs(s).length, 0, 'the retrying call must not wait for setup or record itself');
  await s.event();
  assert.equal(breadcrumbs(s).length, 1, 'a later event must retry a transient list failure');
  assert.equal(attempts, 2);
});

test('a never resolving harvest slot read delays no registered hook beyond the scan bound', async () => {
  const old = fixture();
  await abandoned(old);
  for (const work of ['prompt.context', 'prompt.submit', 'tool.call', 'turn.complete', 'session.compact']) {
    const s = fixture({ files: new Map(old.files) }), hold = deferred();
    s.$.fs.read = () => hold.promise;
    assert.deepEqual(await within(s.event(work), 650, `${work} exceeded the 500 ms harvest scan bound`), { answer: 42 });
    assert.equal(s.calls.some((call) => call.op === 'write'), false, 'an unfinished slot scan must write no breadcrumb');
  }
});

for (const failures of [1, 32]) {
  test(`failed own-slot reads retry on later events under the scan bound and release recovered slots (${failures})`, async () => {
    const old = fixture(), [path, text] = await abandoned(old);
    const complete = JSON.stringify({ ...JSON.parse(text), phase: 'complete' });
    old.files.clear();
    for (let index = 0; index < 32; index++) old.files.set(slotPath(path, index), complete);
    const s = fixture({ files: old.files, prime: false }), read = s.$.fs.read, hold = deferred();
    const failed = new Set(Array.from({ length: failures }, (_, index) => slotPath(path, index)));
    s.$.fs.read = async (file) => { if (failed.has(file)) { throw hostFailure('read', file); } return read(file); };
    await s.event();
    assert.equal(s.calls.some((call) => call.op === 'write'), false, 'failed own-slot scan must not write a breadcrumb');
    s.$.fs.read = async (file) => { await hold.promise; return read(file); };
    await within(s.event('turn.complete'), 650, 'retried slot scan exceeded the 500 ms bound');
    assert.equal(s.calls.filter((call) => call.op === 'list').length, 2, 'failed own-slot reads must leave the scan retryable');
    hold.resolve();
    await new Promise(setImmediate);
    await s.event();
    const work = s.calls.find((call) => call.op === 'write' && call.row.phase === 'work');
    assert.equal(work?.path, slotPath(path, 0), 'a recovered own-slot read must release its reservation, so the lowest slot is reused');
  });
}

test('recorder ignores the inflight prune cursor', async () => {
  const old = fixture(), [, text] = await abandoned(old), s = fixture();
  const path = `${directory}/.inflight-prune`;
  s.files.set(path, text);
  await s.event();
  assert.equal(s.calls.some((call) => call.op === 'read' && call.path === path), false, 'the prune cursor is not a safe slot filename');
  assert.equal(s.files.get(path), text);
  assert.deepEqual(s.logs, []);
});
