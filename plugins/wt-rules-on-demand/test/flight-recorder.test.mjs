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

function fixture({ enabled = true, session = 'fixture/session', files = new Map() } = {}) {
  const handlers = new Map(), calls = [], logs = [], stored = new Map();
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
  const event = async (name = 'session.compact', input = {}, next = async () => ({ answer: 42 })) => {
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

for (const throws of [false, true]) {
  test(`breadcrumb precedes work, enters finally and completes on ${throws ? 'throw' : 'success'}`, async (t) => {
    const time = clock(t), s = fixture(), failure = new Error('downstream failed');
    const promise = s.event('session.compact', { agentId: 'helper' }, async () => {
      assert.equal(breadcrumbs(s).length, 1, 'one breadcrumb must exist before work runs');
      const [path, text] = breadcrumbs(s)[0], row = JSON.parse(text);
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
      const row = JSON.parse(breadcrumbs(s)[0][1]);
      assert.equal(row.work, work);
      assert.equal(row.tool, work === 'tool.call' ? 'Bash' : '');
      assert.equal(row.inputChars, 6);
      return {};
    });
  }
  await s.event('session.compact', { input: { ...input, toJSON() { throw new Error('must not serialize input'); } } });
  await s.event('tool.call', { tool: 'Bash', input: { command: 'x'.repeat(2_000_000) } }, async () => {
    assert.equal(JSON.parse(breadcrumbs(s)[0][1]).inputChars, 1_000_000);
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
    assert.equal(breadcrumbs(s).length, 2);
    assert.equal(new Set(breadcrumbs(s).map(([path]) => path)).size, 2);
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
    saved = breadcrumbs(s)[0];
    return {};
  });
  s.files.set(...saved);
  return saved;
}

test('reload harvests same-session leftovers into health before slot reuse and logs details', async () => {
  const old = fixture(), [path, text] = await abandoned(old);
  const s = fixture({ files: old.files });
  await s.event();
  const row = JSON.parse(text), health = s.stored.get('health');
  assert.deepEqual(health?.interruptedCalls, [{ ...row, path }], 'health must retain the interrupted call after reload');
  assert.ok(s.calls.some((call) => call.op === 'write' && call.path === path && call.row.phase === 'harvested'));
  assert.equal(s.logs.length, 1);
  for (const word of ['interrupted call', 'tool.call', 'Bash', 'work', '3 input chars']) assert.ok(s.logs[0].includes(word));
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
  await s.event();
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

test('harvest progress is alive evidence for the unload detector', () => {
  const timestamp = '2026-01-10T12:00:00.000Z';
  const rows = [
    { content: 'wt-rules-on-demand: wt-rules-on-demand was unloaded: it crashed the hooks worker', timestamp: '2026-01-10T11:59:00.000Z' },
    { content: 'wt-rules-on-demand: wt-rules-on-demand: interrupted call tool.call (Bash), phase work, 3 input chars, started at 2026-01-10T11:58:00.000Z', timestamp },
  ];
  const bytes = Buffer.from(rows.map((row) => JSON.stringify({ type: 'system', subtype: 'informational', ...row }) + '\n').join(''));
  const state = scanTranscript(bytes, scanPlan(bytes.length, null));
  assert.equal(state.aliveAt, timestamp, 'harvest progress must prove the engine is alive');
  assert.equal(announcement(state, { hook_event_name: 'UserPromptSubmit' }, timestamp).output, null);
});

test('first-load harvest finishes reading before any breadcrumb can overwrite a slot', async () => {
  const s = fixture();
  let release, entered;
  const hold = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  s.$.fs.list = async (path) => { if (path === directory) { entered(); return hold; } return []; };
  const result = { deny: 'fixture refusal' };
  const pending = s.event('session.compact', {}, async () => result);
  await ready;
  assert.equal(s.calls.some((call) => call.op === 'write'), false, 'harvest must precede the first slot write');
  release([]);
  assert.equal(await pending, result);
  assert.equal(breadcrumbs(s).length, 1, 'the barrier must eventually allow this event to record');
  assert.deepEqual(s.logs, []);
});

test('failed harvest health write leaves evidence for a later load and failed log never changes a result', async () => {
  const old = fixture(), [path] = await abandoned(old), s = fixture({ files: old.files });
  s.$.store.set = async () => { throw new Error('health unavailable'); };
  assert.deepEqual(await s.event(), { answer: 42 });
  assert.equal(s.files.has(path), true);
  const nextLoad = fixture({ files: s.files });
  nextLoad.$.ui.log = () => { throw new Error('log unavailable'); };
  assert.deepEqual(await nextLoad.event(), { answer: 42 });
  assert.equal(nextLoad.stored.get('health').interruptedCalls.length, 1);
  assert.equal(nextLoad.calls.some((call) => call.op === 'write' && call.path === path && call.row.phase === 'harvested'), false,
    'a failed announcement must leave evidence unmarked');
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
  assert.deepEqual(nextLoad.logs, [], 'an interrupted call must never be reported twice');
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

test('harvest health persistence stays off the serving path while old slots are protected', async () => {
  const old = fixture(), [path, text] = await abandoned(old), s = fixture({ files: old.files });
  let release, entered, workEntered = false;
  const hold = new Promise((resolve) => { release = resolve; });
  const ready = new Promise((resolve) => { entered = resolve; });
  const save = s.$.store.set;
  s.$.store.set = async (name, value) => { if (name === 'health') { entered(); await hold; } await save(name, value); };
  const result = { deny: 'fixture refusal' };
  const pending = s.event('session.compact', {}, async () => { workEntered = true; return result; });
  await ready;
  await new Promise(setImmediate);
  const served = workEntered, protectedSlot = s.files.get(path);
  release();
  assert.equal(await pending, result);
  assert.equal(served, true, 'harvest health persistence must not delay serving');
  assert.equal(protectedSlot, text, 'unpersisted interruption evidence must remain protected from slot reuse');
});

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
      assert.equal(breadcrumbs(s).length, 1, 'a missing inflight directory must not disable the recorder');
      return {};
    });
    assert.equal(JSON.parse(breadcrumbs(s)[0][1]).phase, 'complete');
  });
}

const hostFailure = (op, path, errno = 'EIO') => new Error(`wt-rules-on-demand: $.fs.${op}(${path}) failed: ${errno}`);
const deferred = () => {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
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

test('finally harvest describes unconfirmed completion without a confident interruption', async () => {
  const old = fixture(), [path, text] = await abandoned(old);
  old.files.set(path, JSON.stringify({ ...JSON.parse(text), phase: 'finally' }));
  const s = fixture({ files: old.files });
  await s.event();
  assert.match(s.logs[0], /reached finally, completion not confirmed/);
  assert.doesNotMatch(s.logs[0], /interrupted call/);
});

test('announcement failure leaves the slot available to announce after reload', async () => {
  const old = fixture(), [path, text] = await abandoned(old), s = fixture({ files: old.files });
  s.$.ui.log = () => { throw new Error('ui unavailable'); };
  await s.event();
  assert.equal(s.files.get(path), text, 'log must precede the harvested marker');
  const next = fixture({ files: s.files });
  await next.event();
  assert.equal(next.logs.length, 1, 'a failed log must not consume the announcement');
});

test('persist then failed mark then reload retains one health row per slot identity', async () => {
  const old = fixture(), [path] = await abandoned(old), s = fixture({ files: old.files });
  const write = s.$.fs.write;
  s.$.fs.write = async (file, text) => {
    if (JSON.parse(text).phase === 'harvested') throw hostFailure('write', file);
    return write(file, text);
  };
  await s.event();
  const next = fixture({ files: s.files });
  next.stored.set('health', structuredClone(s.stored.get('health')));
  await next.event();
  assert.equal(next.stored.get('health').interruptedCalls.length, 1, 're-harvest must deduplicate the persisted slot');
  assert.equal(next.stored.get('health').interruptedCalls[0].path, path, 'identity includes the slot path');
});

test('transient listing failure retries on a later event without unsafe writes', async () => {
  const s = fixture(), list = s.$.fs.list;
  let attempts = 0;
  s.$.fs.list = async (path) => {
    if (++attempts === 1) throw hostFailure('list', path);
    return list(path);
  };
  await s.event();
  assert.equal(breadcrumbs(s).length, 0, 'failed scan must not write a slot');
  await s.event();
  assert.equal(breadcrumbs(s).length, 1, 'a later event must retry a transient list failure');
  assert.equal(attempts, 2);
});
