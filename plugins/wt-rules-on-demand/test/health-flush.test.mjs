import { test } from 'node:test';
import assert from 'node:assert/strict';
import { cp, mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import * as live from '../hooks/hooks.js';

const mutation = process.env.ROD_HEALTH_MUTATION;
const source = fileURLToPath(new URL('..', import.meta.url));

async function hooks(t) {
  if (!mutation) { live.resetForSelftest(); return live; }
  const root = await mkdtemp(join(tmpdir(), 'rod-health-mutation-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, 'hooks'));
  await cp(join(source, 'hooks'), join(root, 'hooks'), { recursive: true });
  for (const file of ['paths.js', 'duplicate-rule.js']) await cp(join(source, file), join(root, file));
  await writeFile(join(root, 'package.json'), '{"type":"module"}\n');
  const file = join(root, 'hooks', 'hooks.js');
  let content = await readFile(file, 'utf8');
  const replacements = {
    event: ['if (work === \'turn.complete\' ||', 'if (true ||'],
    failure: ['mergeHealth(pendingHealth, batch);', 'pendingHealth = emptyHealth();'],
    error: ["work === 'turn.complete' || error ||", "work === 'turn.complete' || false ||"],
    count: ['pendingHealth.calls >= 50', 'false'],
  };
  const [from, to] = replacements[mutation];
  if (mutation === 'event' && !content.includes(from)) {
    // The pre-fix implementation already writes on every event; copy it as the red mutant.
    assert.ok(content.includes('finally { await recordHealth($,'), 'pre-fix eager-write seam exists');
  } else {
    assert.ok(content.includes(from), `mutation seam ${mutation} exists`);
    content = content.replace(from, () => to);
  }
  await writeFile(file, content);
  return import(pathToFileURL(file).href);
}

function fixture(register, { failOnce = false, badRule = false, initialHealth = null } = {}) {
  const handlers = new Map(), stored = new Map(), writes = [];
  if (initialHealth) stored.set('health', initialHealth);
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  const $ = {
    env: { get: async (key) => key === 'CLAUDE_CONFIG_DIR' ? '/fixture/config' : null },
    fs: { list: async (path) => badRule && path.endsWith('rules-on-demand') ? [{ name: 'bad.md', kind: 'file' }] : [],
      stat: async (path) => ({ kind: path.endsWith('.md') ? 'file' : 'dir', size: 999999 }) },
    ui: { log: async () => {} }, session: { id: async () => 'one', root: async () => '/fixture', messages: async () => [] },
    store: { get: async (key) => stored.get(key), set: async (key, value) => {
      if (key === 'health') {
        writes.push(value);
        if (failOnce) { failOnce = false; throw new Error('health write failed'); }
      }
      stored.set(key, value);
    } },
  };
  const tool = () => handlers.get('tool.call')($, { tool: 'Agent', cwd: '/fixture' }, async () => ({}));
  const turn = () => handlers.get('turn.complete')($, {}, async () => ({}));
  return { stored, writes, tool, turn };
}

test('ten unmatched tool calls do not write health until turn completion', { skip: mutation && mutation !== 'event' }, async (t) => {
  const { register } = await hooks(t);
  const { stored, writes, tool, turn } = fixture(register);
  for (let i = 0; i < 10; i++) await tool();
  assert.equal(writes.length, 0);
  await turn();
  assert.equal(writes.length, 1);
  assert.equal(Object.values(stored.get('health').days)[0].calls, 11);
});

test('failed flush retains all pending calls for a later successful flush', { skip: mutation && mutation !== 'failure' }, async (t) => {
  const { register } = await hooks(t);
  const day = new Date().toISOString().slice(0, 10);
  const { stored, tool, turn } = fixture(register, { failOnce: true,
    initialHealth: { days: { [day]: { calls: 5, errors: 0, totalMs: 10, maxMs: 2, slow: 0 } }, lastErrors: [] } });
  await tool();
  await turn();
  await turn();
  assert.equal(stored.get('health').days[day].calls, 8);
});

test('stored health has only days and lastErrors, even after a failed flush', { skip: !!mutation }, async (t) => {
  const { register } = await hooks(t);
  const { stored, writes, tool, turn } = fixture(register, { failOnce: true });
  await tool();
  await turn();
  assert.equal(stored.has('health'), false);
  await tool();
  await turn();
  assert.equal(writes.length, 2);
  assert.equal(Object.values(stored.get('health').days)[0].calls, 4);
  for (const health of writes) {
    assert.deepEqual(Object.keys(health).sort(), ['days', 'lastErrors']);
    assert.doesNotMatch(JSON.stringify(health), /null/);
    const check = (value) => {
      assert.notEqual(value, null);
      if (typeof value === 'number') assert.ok(Number.isFinite(value));
      if (value && typeof value === 'object') for (const entry of Object.values(value)) check(entry);
    };
    check(health);
  }
});

test('plugin error flushes health immediately without a turn', { skip: mutation && mutation !== 'error' }, async (t) => {
  const { register } = await hooks(t);
  const { stored, writes, tool } = fixture(register, { badRule: true });
  await tool();
  assert.ok(writes.length > 0);
  assert.ok(Object.values(stored.get('health').days)[0].errors >= 1);
});

test('fifty pending calls flush health without a turn', { skip: mutation && mutation !== 'count' }, async (t) => {
  const { register } = await hooks(t);
  const { stored, writes, tool } = fixture(register);
  for (let i = 0; i < 50; i++) await tool();
  assert.equal(writes.length, 1);
  assert.equal(Object.values(stored.get('health').days)[0].calls, 50);
});

test('elapsed minute flushes pending calls on the next event', { skip: !!mutation }, async (t) => {
  const RealDate = Date;
  let now = RealDate.now();
  class ClockDate extends RealDate { static now() { return now; } }
  globalThis.Date = ClockDate;
  try {
    const { register } = await hooks(t);
    const { stored, writes, tool } = fixture(register);
    await tool();
    assert.equal(writes.length, 0);
    now += 60_000;
    await tool();
    assert.equal(writes.length, 1);
    assert.equal(Object.values(stored.get('health').days)[0].calls, 2);
  } finally { globalThis.Date = RealDate; }
});

test('a stored day missing a counter field is merged as numbers, not NaN', { skip: !!mutation }, async (t) => {
  const { register } = await hooks(t);
  const day = new Date().toISOString().slice(0, 10);
  // Entries written by an older shape: today lacks totalMs and slow, an older day lacks everything but calls.
  const { stored, writes, tool, turn } = fixture(register,
    { initialHealth: { days: { [day]: { calls: 5, errors: 1, maxMs: 2 }, '2000-01-01': { calls: 3 } }, lastErrors: [] } });
  await tool();
  await turn();
  assert.equal(writes.length, 1);
  const { days } = stored.get('health');
  for (const field of ['calls', 'errors', 'totalMs', 'maxMs', 'slow']) assert.ok(Number.isFinite(days[day][field]), `${day}.${field} is ${days[day][field]}`);
  for (const [name, entry] of Object.entries(days)) {
    assert.deepEqual(Object.keys(entry).sort(), ['calls', 'errors', 'maxMs', 'slow', 'totalMs'], name);
    for (const [field, value] of Object.entries(entry)) assert.ok(Number.isFinite(value), `${name}.${field} is ${value}`);
  }
  assert.equal(days[day].calls, 7);
  assert.equal(days[day].errors, 1);
  assert.equal(days['2000-01-01'].calls, 3);
  assert.equal(days['2000-01-01'].totalMs, 0);
  assert.doesNotMatch(JSON.stringify(writes[0]), /null/);
});

test('malformed stored error history and negative counters do not block or skew later flushes', { skip: !!mutation }, async (t) => {
  const { register } = await hooks(t);
  const day = new Date().toISOString().slice(0, 10);
  const { stored, tool, turn } = fixture(register, { initialHealth: {
    days: { [day]: { calls: 5, errors: 0, totalMs: 10, maxMs: 2, slow: 0 }, '2000-01-01': { calls: -5, errors: 0, totalMs: 0, maxMs: 0, slow: 0 } },
    lastErrors: [{}, null, { at: '2000-01-01T00:00:00.000Z', message: 'kept' }] } });
  await tool();
  await turn();
  const health = stored.get('health');
  assert.equal(health.days[day].calls, 7);
  assert.equal(health.days['2000-01-01'].calls, 0);
  assert.deepEqual(health.lastErrors, [{ at: '2000-01-01T00:00:00.000Z', message: 'kept' }]);
});
