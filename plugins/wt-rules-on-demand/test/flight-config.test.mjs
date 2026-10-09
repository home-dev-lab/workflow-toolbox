import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, resetForSelftest } from '../hooks/hooks.js';

function host() {
  resetForSelftest();
  const handlers = new Map(), env = [], writes = [], stored = new Map();
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  const $ = {
    env: { get: async (name) => { env.push(name); return name === 'CLAUDE_CONFIG_DIR' ? '/fixture/config' : null; } },
    session: { id: async () => 'fixture/session', root: async () => '/fixture', messages: async () => [] },
    fs: { list: async (path) => path === '/fixture/config/rules-on-demand' ? [{ name: 'warm.md', kind: 'file' }] : [],
      stat: async () => ({ kind: 'dir' }),
      read: async () => '---\non-demand:\n  triggers:\n    - kind: tool\n      tool: "^Agent$"\n      unconditional: true\n  compliance:\n    kind: none\n    reason: fixture\n---\nWarm rule.\n',
      write: async (path, value) => { writes.push({ path, row: JSON.parse(value) }); } },
    store: { get: async (name) => stored.get(name), set: async (name, value) => stored.set(name, value) },
    ui: { log: async () => {} },
  };
  const call = (name) => handlers.get(name)($, { cwd: '/fixture', tool: 'Agent' }, async () => ({}));
  return { $, call, env, writes };
}

test('recorder adds no environment reads beside one engine load', async () => {
  const s = host();
  await s.call('tool.call');
  assert.deepEqual(s.env, ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE'], 'one engine load must resolve the environment exactly once');
});

test('the first call before an engine load runs without recorder I/O', async () => {
  const s = host();
  await s.call('session.compact');
  assert.deepEqual(s.env, [], 'the recorder must not read the environment before the engine loads');
  assert.deepEqual(s.writes, [], 'the first call without a resolved config must be unrecorded');
});

test('the first engine load is unrecorded and the next hook records in phase order', async () => {
  const s = host();
  await s.call('tool.call');
  assert.deepEqual(s.writes, [], 'the first engine load must finish without a breadcrumb');
  await s.call('session.compact');
  await new Promise(setImmediate);
  assert.deepEqual(s.writes.map(({ row }) => row.phase), ['work', 'finally', 'complete'], 'the next hook must record after config resolution');
  assert.deepEqual(s.env, ['CLAUDE_CONFIG_DIR', 'HOME', 'USERPROFILE']);
});

test('a stalled recorder environment read cannot hold concurrent serving work', async () => {
  const s = host();
  s.$.env.get = () => new Promise(() => {});
  const first = s.call('session.compact');
  const second = s.call('session.compact');
  let timer;
  try {
    const result = await Promise.race([second.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 200); })]);
    assert.equal(result, true, 'concurrent serving work must not wait for a recorder environment read');
  } finally { clearTimeout(timer); await first; }
});

test('missing fs.write disables recorder attempts for the load', async () => {
  const s = host();
  let attempts = 0;
  delete s.$.fs.write;
  s.$.fs = new Proxy(s.$.fs, { get(target, key) {
    if (key === 'write') { attempts++; }
    return Reflect.get(target, key);
  } });
  await s.call('tool.call');
  for (let index = 0; index < 40; index++) {
    await s.call('session.compact');
  }
  await new Promise(setImmediate);
  assert.equal(attempts, 1, 'a host without fs.write must be checked once and switched off for that load');
});

test('a pending recorder scan never makes a concurrent hook join its wait', async () => {
  const s = host();
  let entered;
  const listed = new Promise((resolve) => { entered = resolve; });
  const list = s.$.fs.list;
  s.$.fs.list = async (path) => {
    if (path.endsWith('/inflight')) { entered(); return new Promise(() => {}); }
    return list(path);
  };
  await s.call('tool.call');
  const first = s.call('session.compact');
  await listed;
  let timer;
  try {
    const second = s.call('session.compact');
    const result = await Promise.race([second.then(() => true), new Promise((resolve) => { timer = setTimeout(() => resolve(false), 200); })]);
    assert.equal(result, true, 'a concurrent hook must not join another call\'s pending recorder scan');
  } finally { clearTimeout(timer); await first; }
});

test('recorder entry adds no suspension or host read before serving admission', async () => {
  const s = host();
  await s.call('tool.call');
  await new Promise(setImmediate);
  let entered = false, sessions = 0, admitted = false;
  s.$.session.id = async () => { sessions++; return 'fixture/session'; };
  const handlers = new Map();
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  // Distinguish the engine's synchronous loop resolution from recorder metadata reads.
  const event = { cwd: '/fixture', tool: 'Agent', get agentId() {
    if (new Error().stack.includes('toolCallWork')) { admitted = true; }
    return 'helper';
  } };
  const pending = handlers.get('tool.call')(s.$, event, async () => { entered = true; return {}; });
  try { assert.equal(admitted, true, 'serving must resolve its agent loop without a recorder suspension'); }
  finally { await pending; }
  assert.equal(sessions, 1, 'recorder must reuse the engine session lookup');
  assert.equal(entered, true);
});

test('a cold scan never holds serving', async () => {
  const s = host();
  const list = s.$.fs.list;
  s.$.fs.list = async (path) => path.endsWith('/inflight') ? new Promise(() => {}) : list(path);
  await s.call('tool.call');
  const began = performance.now();
  await s.call('session.compact');
  assert.ok(performance.now() - began < 100, 'a cold recorder scan must add no serving wait');
  assert.deepEqual(s.writes, [], 'calls before setup finishes must dispatch no breadcrumb');
});

test('a dispatched but stalled breadcrumb adds no serving wait', async () => {
  const s = host();
  await s.call('tool.call');
  await s.call('session.compact');
  await new Promise(setImmediate);
  s.$.fs.write = () => new Promise(() => {});
  const began = performance.now();
  await s.call('session.compact');
  assert.ok(performance.now() - began < 100, 'a dispatched entry write must add no serving wait');
});

test('recorder setup reuses session identity already resolved by journaling', async () => {
  const s = host();
  let reads = 0;
  s.$.session.id = async () => { reads++; return 'fixture/session'; };
  await s.call('tool.call');
  await new Promise(setImmediate);
  assert.equal(reads, 1, 'one engine load must read session identity exactly once');
  await s.call('session.compact');
  assert.equal(reads, 2, 'only the engine journal may read session identity');
});
