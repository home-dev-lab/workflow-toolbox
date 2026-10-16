import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { register, resetForSelftest } from '../hooks/hooks.js';

const rule = `---
on-demand:
  triggers:
    - kind: 'tool'
      tool: '^Agent$'
      unconditional: 'true'
      before-first-act: 'true'
  compliance:
    kind: 'none'
    reason: 'fixture'
---
Synthetic instruction for the acting agent.
`;

let savedAgentTypes;
beforeEach(() => {
  savedAgentTypes = process.env.WT_ROD_NO_REFUSE_AGENT_TYPES;
  delete process.env.WT_ROD_NO_REFUSE_AGENT_TYPES;
});
afterEach(() => {
  if (savedAgentTypes === undefined) delete process.env.WT_ROD_NO_REFUSE_AGENT_TYPES;
  else process.env.WT_ROD_NO_REFUSE_AGENT_TYPES = savedAgentTypes;
});

// The host runs the hooks module without Node.js globals, so the project setting reaches it only
// through $.env.get(). A decoy in process.env proves the module never reads it from there.
function fixture(config = 'my-agent', enabled = true, options = {}, decoy = 'decoy-type', clock = Date.now, lookupClock = Date.now) {
  resetForSelftest();
  process.env.WT_ROD_NO_REFUSE_AGENT_TYPES = decoy;
  const handlers = new Map(), store = new Map(), logs = [], envReads = [];
  let lookups = 0, acts = 0;
  register((name, handler) => handlers.set(name, handler), { enabled, ...options }, clock, lookupClock);
  const $ = {
    env: { get: async (key) => {
      envReads.push(key);
      if (key === 'CLAUDE_CONFIG_DIR') return '/synthetic-config';
      return key === 'WT_ROD_NO_REFUSE_AGENT_TYPES' && config !== null ? config : undefined;
    } },
    fs: { list: async (dir) => dir === '/synthetic-config/rules-on-demand' ? [{ kind: 'file', name: 'sample.md' }] : [],
      read: async () => rule, stat: async (path) => ({ kind: 'file', size: rule.length, realPath: path }) },
    ui: { log: (message) => { logs.push(message); } },
    session: { id: async () => 'synthetic-session', messages: async () => [{ role: 'assistant' }] },
    store: { get: async (key) => store.get(key), set: async (key, value) => store.set(key, value) },
    model: { classify: async () => 'followed' },
    agent: { list: async () => { lookups++; return []; } },
  };
  const event = (name, e, next) => handlers.has(name) ? handlers.get(name)($, e, next) : next(e);
  const spawn = (e = {}, result = { model: 'synthetic', agentId: 'worker' }) =>
    event('agent.spawn', { subagentType: 'my-agent', ...e }, async () => result);
  const call = (e = {}) => event('tool.call', { cwd: '/synthetic-project', tool: 'Agent', ...e },
    async () => { acts++; return { context: ['original context'] }; });
  return { $, handlers, logs, event, spawn, call, envReads, lookups: () => lookups, acts: () => acts };
}

function assertDelivered(result) {
  assert.equal(result.deny, undefined, 'listed agent type must not be refused');
  assert.equal(result.context[0], 'original context');
  assert.ok(result.context.some((text) => text.includes('Synthetic instruction for the acting agent.')));
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

function setting(f, read) {
  const original = f.$.env.get;
  f.$.env.get = (key) => key === 'WT_ROD_NO_REFUSE_AGENT_TYPES' ? read() : original(key);
}

async function compact(f, agentId = 'worker') {
  await f.event('session.compact', { agentId }, async () => ({}));
}

test('older env read cannot restore exemptions after a newer empty read', async () => {
  const f = fixture(), older = deferred();
  await f.spawn();
  let reads = 0;
  setting(f, () => ++reads === 1 ? older.promise : '');
  const first = f.call({ agentId: 'worker' });
  await new Promise((resolve) => setImmediate(resolve));
  await f.call({ agentId: 'reader' });
  older.resolve('my-agent');
  assert.ok((await first).deny, 'stale env read must not grant a waiver');
  await compact(f);
  setting(f, () => '');
  assert.ok((await f.call({ agentId: 'worker' })).deny, 'older env read must not restore exemptions');
});

for (const type of ['other-agent', 'my-agent']) {
  test(`spawn evidence overtakes a delayed lookup: ${type}`, async () => {
    const f = fixture(), started = deferred(), lookup = deferred();
    f.$.agent.list = () => { started.resolve(); return lookup.promise; };
    const call = f.call({ agentId: 'worker' });
    await started.promise;
    await f.spawn({ subagentType: type });
    lookup.resolve([{ id: 'worker', type: type === 'my-agent' ? 'other-agent' : 'my-agent' }]);
    const result = await call;
    if (type === 'my-agent') assertDelivered(result);
    else assert.ok(result.deny, 'newer unlisted spawn must beat stale listed lookup');
  });
}

for (const failure of ['throw', 'miss', 'timeout']) {
  test(`a ${failure} lookup retries and accepts healthy evidence`, async () => {
    let now = 0;
    const f = fixture('my-agent', true, {}, 'decoy', Date.now, () => now), hung = deferred();
    if (failure === 'timeout') f.$.clock = { sleep: () => new Promise((resolve) => setTimeout(resolve, 10)) };
    f.$.agent.list = () => {
      if (failure === 'throw') throw new Error('unavailable');
      return failure === 'miss' ? [] : hung.promise;
    };
    assert.ok((await f.call({ agentId: 'worker' })).deny);
    // Host lookup slots outlive a reset, so a request this test leaves hanging would hold one for later tests.
    hung.resolve([]);
    await compact(f);
    now = 1001;
    f.$.agent.list = async () => [{ id: 'worker', type: 'my-agent' }];
    assertDelivered(await f.call({ agentId: 'worker' }));
  });
}

test('concurrent calls for one unknown identity share a lookup', async () => {
  const f = fixture(), started = deferred(), lookup = deferred();
  let lookups = 0;
  f.$.agent.list = () => { lookups++; started.resolve(); return lookup.promise; };
  const first = f.call({ agentId: 'worker' });
  await started.promise;
  const second = f.call({ agentId: 'worker' });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(lookups, 1, 'concurrent unknown identity must have one in-flight lookup');
  lookup.resolve([{ id: 'worker', type: 'my-agent' }]);
  const results = await Promise.all([first, second]);
  assert.ok(results.every((result) => !result.deny));
  assert.ok(results.some((result) => result.context.some((text) => text.includes('Synthetic instruction'))));
});

test('equivalent parsed settings preserve learned workflow identities', async () => {
  const f = fixture();
  await f.spawn({ workflow: { runId: 'wf_x', agentIndex: 1 } });
  assertDelivered(await f.call({ agentId: 'worker' }));
  await compact(f);
  setting(f, () => ' my-agent ');
  assertDelivered(await f.call({ agentId: 'worker' }));
  assert.equal(f.lookups(), 0);
});

test('explicit main identity is never waived or looked up', async () => {
  const f = fixture();
  await f.spawn({}, { agentId: 'main' });
  assert.ok((await f.call({ agentId: 'main' })).deny, 'explicit main must retain before-act refusal');
  assert.equal(f.lookups(), 0);
});

test('waiver logging follows the act and cannot hold it pending', { timeout: 1000 }, async () => {
  const f = fixture(), logging = deferred(), release = deferred();
  await f.spawn();
  let actsAtLog;
  f.$.ui.log = (message) => {
    if (!message.includes('waiving')) return undefined;
    actsAtLog = f.acts();
    logging.resolve();
    return release.promise;
  };
  const call = f.call({ agentId: 'worker' });
  await logging.promise;
  assert.equal(actsAtLog, 1, 'the waiver logger must be invoked only after the act was handed to the host');
  await f.spawn({ subagentType: 'other-agent' });
  release.resolve();
  assertDelivered(await call);
});

test('a setting change and a newer spawn during a lookup beat its stale answer', async () => {
  const f = fixture(), started = deferred(), lookup = deferred();
  f.$.agent.list = () => { started.resolve(); return lookup.promise; };
  const call = f.call({ agentId: 'worker' });
  await started.promise;
  setting(f, () => 'my-agent, extra-agent');
  await f.spawn({ subagentType: 'other-agent' });
  lookup.resolve([{ id: 'worker', type: 'my-agent' }]);
  assert.ok((await call).deny, 'spawn evidence must beat a lookup across configuration changes');
});

test('project A lists the type: spawned agent runs once and receives the rule with its result', async () => {
  const f = fixture('lean-probe');
  await f.spawn({ subagentType: 'lean-probe' });
  assertDelivered(await f.call({ agentId: 'worker' }));
  assert.equal(f.acts(), 1);
  assert.equal(f.lookups(), 0);
  assert.equal(f.logs.filter((line) => line.includes('waiv')).length, 1);
});

test('unlisted spawned type is still refused without a lookup', async () => {
  const f = fixture();
  await f.spawn({ subagentType: 'other-agent' });
  assert.ok((await f.call({ agentId: 'worker' })).deny);
  assert.equal(f.acts(), 0);
  assert.equal(f.lookups(), 0);
});

test('main loop is never exempted or looked up', async () => {
  const f = fixture();
  await f.spawn();
  assert.ok((await f.call()).deny);
  assert.equal(f.lookups(), 0);
  await f.spawn({}, { agentId: 'main' });
  await compact(f, 'main');
  assert.ok((await f.call({ agentId: 'main' })).deny);
});

test('unknown id stays refused when list throws, and retries after backoff', async () => {
  let now = 0;
  const f = fixture('my-agent', true, {}, 'decoy', Date.now, () => now);
  let lookups = 0;
  f.$.agent.list = async () => { lookups++; throw new Error('unavailable'); };
  assert.ok((await f.call({ agentId: 'unknown' })).deny);
  await f.event('session.compact', { agentId: 'unknown' }, async () => ({}));
  now = 1001;
  assert.ok((await f.call({ agentId: 'unknown' })).deny);
  assert.equal(lookups, 2, 'failed lookups must be retried');
});

test('list resolves an agent spawned before module load and caches its type', async () => {
  const f = fixture();
  let lookups = 0;
  f.$.agent.list = async () => { lookups++; return [{ id: 'worker', type: 'my-agent' }]; };
  assertDelivered(await f.call({ agentId: 'worker' }));
  await f.event('session.compact', { agentId: 'worker' }, async () => ({}));
  assertDelivered(await f.call({ agentId: 'worker' }));
  assert.equal(lookups, 1);
});

test('an absent list entry remains refused', async () => {
  const f = fixture();
  assert.ok((await f.call({ agentId: 'unknown' })).deny);
  assert.equal(f.lookups(), 1);
});

test('workflow spawn learns a type without relying on the agent list', async () => {
  const f = fixture();
  await f.spawn({ workflow: { runId: 'wf_x', agentIndex: 1 } });
  assertDelivered(await f.call({ agentId: 'worker' }));
  assert.equal(f.lookups(), 0);
});

test('resume uses its existing id when the spawn result has only model', async () => {
  const f = fixture();
  await f.spawn({ resume: { agentId: 'worker' } }, { model: 'synthetic' });
  assertDelivered(await f.call({ agentId: 'worker' }));
});

for (const config of [' other-agent, my-agent, , ', ' , , my-agent , ']) {
  test(`configuration trims names and ignores empty entries: ${JSON.stringify(config)}`, async () => {
    const f = fixture(config);
    await f.spawn();
    assertDelivered(await f.call({ agentId: 'worker' }));
  });
}

test('wildcard syntax never exempts another type', async () => {
  const f = fixture('*');
  await f.spawn();
  assert.ok((await f.call({ agentId: 'worker' })).deny);
});

test('a literal star is an exact type name', async () => {
  const f = fixture('*');
  await f.spawn({ subagentType: '*' });
  assertDelivered(await f.call({ agentId: 'worker' }));
});

test('type names remain case-sensitive', async () => {
  const f = fixture('My-agent');
  await f.spawn();
  assert.ok((await f.call({ agentId: 'worker' })).deny);
});

for (const config of [null, '', ' ', ',', ' , , ']) {
  test(`absent or empty configuration waives nothing and looks nothing up: ${JSON.stringify(config)}`, async () => {
    const f = fixture(config);
    await f.spawn();
    assert.ok((await f.call({ agentId: 'worker' })).deny);
    assert.ok((await f.call({ agentId: 'unknown' })).deny);
    assert.equal(f.lookups(), 0);
    await compact(f);
    setting(f, () => 'my-agent');
    assertDelivered(await f.call({ agentId: 'worker' }));
    assert.equal(f.lookups(), 0, 'spawn evidence survives an initially empty setting');
  });
}

test('project B without the setting refuses the same type', async () => {
  const f = fixture(null);
  await f.spawn({ subagentType: 'lean-probe' });
  assert.ok((await f.call({ agentId: 'worker' })).deny);
  assert.equal(f.lookups(), 0);
});

test('a type named only in process.env is never exempted', async () => {
  const f = fixture(null, true, {}, 'lean-probe');
  await f.spawn({ subagentType: 'lean-probe' });
  let lookups = 0;
  f.$.agent.list = async () => { lookups++; return [{ id: 'worker', type: 'lean-probe' }]; };
  assert.ok((await f.call({ agentId: 'worker' })).deny);
  assert.equal(lookups, 0);
});

test('the setting is read through the host environment API by its literal name', async () => {
  const f = fixture('lean-probe');
  await f.spawn({ subagentType: 'lean-probe' });
  assertDelivered(await f.call({ agentId: 'worker' }));
  assert.ok(f.envReads.includes('WT_ROD_NO_REFUSE_AGENT_TYPES'));
});

test('an environment read that throws leaves refusals in force', async () => {
  const f = fixture('lean-probe');
  f.$.env.get = async (key) => { if (key === 'WT_ROD_NO_REFUSE_AGENT_TYPES') throw new Error('env unavailable');
    return key === 'CLAUDE_CONFIG_DIR' ? '/synthetic-config' : undefined; };
  await f.spawn({ subagentType: 'lean-probe' });
  assert.ok((await f.call({ agentId: 'worker' })).deny);
  assert.equal(f.lookups(), 0);
});

test('plugin options no longer exempt an agent type when the env setting is absent', async () => {
  const f = fixture(null, true, { no_refuse_agent_types: ['lean-probe'] });
  await f.spawn({ subagentType: 'lean-probe' });
  let lookups = 0;
  f.$.agent.list = async () => { lookups++; return [{ id: 'worker', type: 'lean-probe' }]; };
  assert.ok((await f.call({ agentId: 'worker' })).deny, 'plugin options must not exempt the type');
  assert.equal(lookups, 0);
});

test('denied spawn records neither returned nor resume identity', async () => {
  const f = fixture();
  const denied = { deny: 'not started', agentId: 'worker' };
  assert.equal(await f.spawn({ resume: { agentId: 'worker' } }, denied), denied);
  assert.ok((await f.call({ agentId: 'worker' })).deny);
  assert.equal(f.lookups(), 1);
});

test('spawn forwards the original event and returns the same result object', async () => {
  const f = fixture();
  const input = { subagentType: 'my-agent' }, result = { model: 'synthetic', agentId: 'worker', deny: undefined };
  const answer = await f.handlers.get('agent.spawn')(f.$, input, async (received) => {
    assert.equal(received, input);
    return result;
  });
  assert.equal(answer, result);
  assertDelivered(await f.call({ agentId: 'worker' }));
});

test('disabled plugin passes through without reading spawn metadata or agent list', async () => {
  const f = fixture('my-agent', false);
  const input = { get subagentType() { throw new Error('must not inspect'); } };
  const result = { model: 'synthetic', agentId: 'worker' };
  assert.equal(await f.handlers.get('agent.spawn')(f.$, input, async () => result), result);
  assert.equal((await f.call({ agentId: 'worker' })).deny, undefined);
  assert.equal(f.lookups(), 0);
  register((name, handler) => f.handlers.set(name, handler), { enabled: true });
  await f.spawn();
  assertDelivered(await f.call({ agentId: 'worker' }));
});

test('spawn bookkeeping cannot fail an otherwise successful spawn', async () => {
  const f = fixture();
  await f.spawn();
  const input = { get subagentType() { throw new Error('metadata unavailable'); } };
  const result = { model: 'synthetic', agentId: 'worker' };
  assert.equal(await f.handlers.get('agent.spawn')(f.$, input, async () => result), result);
  assert.ok((await f.call({ agentId: 'worker' })).deny, 'failed bookkeeping must forget the previous occupant');
});

test('a rejected spawn propagates the host error unchanged and learns nothing', async () => {
  const f = fixture();
  const failure = new Error('spawn unavailable');
  await assert.rejects(() => f.handlers.get('agent.spawn')(f.$, { subagentType: 'my-agent' },
    async () => { throw failure; }), (error) => error === failure);
  assert.ok((await f.call({ agentId: 'worker' })).deny);
});

test('a lookup miss is replaced by the type a later spawn reports', async () => {
  const f = fixture();
  assert.ok((await f.call({ agentId: 'worker' })).deny);
  await f.spawn();
  // The refusal served the rule for this context; a compaction makes it refusable again.
  await f.event('session.compact', { agentId: 'worker' }, async () => ({}));
  assertDelivered(await f.call({ agentId: 'worker' }));
});

test('a call that matches no before-rule reads neither the setting nor the agent list', async () => {
  const f = fixture();
  await f.call({ agentId: 'worker', tool: 'Read' });
  assert.equal(f.lookups(), 0);
  assert.equal(f.envReads.includes('WT_ROD_NO_REFUSE_AGENT_TYPES'), false);
  await f.spawn();
  assertDelivered(await f.call({ agentId: 'worker' }));
});

test('a waived rule is delivered once per context, not on every call', async () => {
  const f = fixture();
  await f.spawn();
  assertDelivered(await f.call({ agentId: 'worker' }));
  const second = await f.call({ agentId: 'worker' });
  assert.equal(second.deny, undefined);
  assert.equal(second.context.some((text) => text.includes('Synthetic instruction for the acting agent.')), false);
});

test('an agent list that never answers is cut off by the host deadline and refused', { timeout: 5000 }, async () => {
  const f = fixture();
  f.$.clock = { sleep: (ms, options) => new Promise((resolve) => {
    const timer = setTimeout(resolve, 20);
    options?.signal?.addEventListener('abort', () => clearTimeout(timer));
  }) };
  const hung = deferred();
  f.$.agent.list = () => hung.promise;
  assert.ok((await f.call({ agentId: 'worker' })).deny);
  hung.resolve([]);
});

test('registration clears previously learned types', async () => {
  const f = fixture();
  await f.spawn();
  register((name, handler) => f.handlers.set(name, handler), { enabled: true });
  assert.ok((await f.call({ agentId: 'worker' })).deny);
  assert.equal(f.lookups(), 1);
});

test('selftest reset clears learned types', async () => {
  const f = fixture();
  await f.spawn();
  resetForSelftest();
  assert.ok((await f.call({ agentId: 'worker' })).deny);
});

test('oldest learned identities are dropped from the bounded map', async () => {
  const f = fixture();
  for (let i = 0; i < 257; i++) await f.spawn({}, { model: 'synthetic', agentId: `worker-${i}` });
  assert.ok((await f.call({ agentId: 'worker-0' })).deny);
  assertDelivered(await f.call({ agentId: 'worker-256' }));
  assert.equal(f.lookups(), 1);
});

test('logging failures do not turn a waiver into a refusal', async () => {
  const f = fixture();
  await f.spawn();
  f.$.ui.log = (message) => { if (message.includes('waiv')) throw new Error('log unavailable'); };
  assertDelivered(await f.call({ agentId: 'worker' }));
});

// Exhaustion is a shared pre-act await in both implementations, unlike the waiver log.
function pausedDecision(config = 'my-agent') {
  let ticks = 0;
  const f = fixture(config, true, {}, 'decoy-type', () => ticks++ * 3000);
  const started = deferred(), release = deferred();
  f.$.ui.log = async (message) => {
    if (message.includes('shared regex budget exhausted:')) {
      started.resolve();
      await release.promise;
    }
  };
  return { f, started, release };
}

test('L1 current membership wins after a setting change and spawn at the pre-act await', async () => {
  const { f, started, release } = pausedDecision();
  await f.spawn();
  const call = f.call({ agentId: 'worker' });
  await started.promise;
  setting(f, () => 'other-agent');
  f.$.ui.log = () => {};
  await f.call({ agentId: 'reader', tool: 'Agent' });
  await f.spawn();
  release.resolve();
  assert.ok((await call).deny, 'L1 current unlisted type must be refused');
});

test('L2 clearing the setting during a pre-act await keeps the refusal', async () => {
  const { f, started, release } = pausedDecision();
  await f.spawn();
  const call = f.call({ agentId: 'worker' });
  await started.promise;
  setting(f, () => '');
  // The second call must not wait on the same progress barrier.
  f.$.ui.log = () => {};
  await f.call({ agentId: 'reader' });
  release.resolve();
  assert.ok((await call).deny, 'L2 a cleared setting must stop the pending act');
});

test('L3 an older spawn cannot overwrite a newer completed spawn', async () => {
  const f = fixture(), held = deferred();
  const first = f.event('agent.spawn', { subagentType: 'my-agent' }, () => held.promise);
  await f.spawn({ subagentType: 'other-agent' });
  held.resolve({ agentId: 'worker' });
  await first;
  assert.ok((await f.call({ agentId: 'worker' })).deny, 'L3 newer spawn evidence must win');
});

test('L4 a pending resume blocks the previous occupant waiver', async () => {
  const f = fixture(), held = deferred();
  await f.spawn();
  f.$.agent.list = async () => [{ id: 'worker', type: 'my-agent' }];
  const spawn = f.event('agent.spawn', { resume: { agentId: 'worker' }, subagentType: 'other-agent' }, () => held.promise);
  const result = await f.call({ agentId: 'worker' });
  held.resolve({ agentId: 'worker' });
  await spawn;
  assert.ok(result.deny, 'L4 a pending resume must keep before-act refusal');
});

test('explicit main stays refused after another agent applied the setting', async () => {
  const f = fixture();
  await f.spawn();
  assertDelivered(await f.call({ agentId: 'worker' }));
  await f.spawn({}, { model: 'synthetic', agentId: 'main' });
  assert.ok((await f.call({ agentId: 'main' })).deny, 'the main loop must never be waived, even with a listed type recorded');
});

test('a second pending resume keeps the refusal after the first settles', async () => {
  const f = fixture(), first = deferred(), second = deferred();
  const a = f.event('agent.spawn', { resume: { agentId: 'worker' }, subagentType: 'my-agent' }, () => first.promise);
  const b = f.event('agent.spawn', { resume: { agentId: 'worker' }, subagentType: 'other-agent' }, () => second.promise);
  first.resolve({ agentId: 'worker' });
  await a;
  const result = await f.call({ agentId: 'worker' });
  second.resolve({ agentId: 'worker' });
  await b;
  assert.ok(result.deny, 'a resume still in flight must keep the refusal');
});

test('an older spawn cannot restore a type once the newer record was evicted', async () => {
  const f = fixture(), held = deferred();
  const older = f.event('agent.spawn', { subagentType: 'my-agent' }, () => held.promise);
  await f.spawn({ subagentType: 'other-agent' });
  for (let i = 0; i < 256; i++) await f.spawn({ subagentType: 'other-agent' }, { model: 'synthetic', agentId: `filler-${i}` });
  held.resolve({ model: 'synthetic', agentId: 'worker' });
  await older;
  assert.ok((await f.call({ agentId: 'worker' })).deny, 'an evicted newer record must not let older evidence back in');
});

test('L5 movement between listed types during the pre-act await is waived', async () => {
  const { f, started, release } = pausedDecision('my-agent,second-agent');
  await f.spawn();
  const call = f.call({ agentId: 'worker' });
  await started.promise;
  await f.spawn({ subagentType: 'second-agent' });
  release.resolve();
  assertDelivered(await call);
});

test('L6 a throwing deny getter forgets the resolved result id', async () => {
  const f = fixture();
  await f.spawn();
  await f.spawn({}, { agentId: 'worker', get deny() { throw new Error('unreadable'); } });
  assert.ok((await f.call({ agentId: 'worker' })).deny, 'L6 unreadable spawn result must forget its known id');
});

test('L7 at most 32 distinct lookups may be in flight', async () => {
  const f = fixture(), held = deferred();
  let requests = 0;
  f.$.agent.list = () => { requests++; return held.promise; };
  const calls = Array.from({ length: 33 }, (_, i) => f.call({ agentId: `unknown-${i}` }));
  await new Promise((resolve) => setImmediate(resolve));
  const count = requests;
  held.resolve([]);
  const results = await Promise.all(calls);
  assert.equal(count, 32, 'L7 no more than 32 list requests may be pending');
  assert.ok(results[32].deny, 'L7 overflow must be refused');
});

test('L8 failed lookups back off until the injected clock passes the deadline', async () => {
  let now = 0, requests = 0;
  const f = fixture('my-agent', true, {}, 'decoy', Date.now, () => now);
  f.$.agent.list = async () => { requests++; throw new Error('unavailable'); };
  assert.ok((await f.call({ agentId: 'worker' })).deny);
  await compact(f);
  assert.ok((await f.call({ agentId: 'worker' })).deny);
  assert.equal(requests, 1, 'L8 an immediate retry must not issue another list request');
  await compact(f);
  now = 1001;
  f.$.agent.list = async () => [{ id: 'worker', type: 'my-agent' }];
  assertDelivered(await f.call({ agentId: 'worker' }));
});

test('a logger that re-enters with a resume cannot run between the decision and the act', async () => {
  const f = fixture(), held = deferred();
  await f.spawn();
  let resume, resuming = false, actedWhileResuming = false;
  f.$.ui.log = (message) => {
    if (!message.includes('waiving') || resume) return;
    resuming = true;
    resume = f.event('agent.spawn', { resume: { agentId: 'worker' }, subagentType: 'other-agent' }, () => held.promise);
  };
  const result = await f.event('tool.call', { cwd: '/synthetic-project', tool: 'Agent', agentId: 'worker' },
    async () => { actedWhileResuming ||= resuming; return { context: ['original context'] }; });
  held.resolve({ agentId: 'worker' });
  await resume;
  assert.equal(actedWhileResuming, false, 'no host callback may run between the waiver decision and the act');
  assertDelivered(result);
  await compact(f);
  assert.ok((await f.call({ agentId: 'worker' })).deny, 'the settled unlisted resume is refused');
});

test('no microtask boundary separates the waiver decision from the act', async () => {
  const outcomes = new Set();
  for (let hops = 0; hops < 40; hops++) {
    const { f, started, release } = pausedDecision();
    await f.spawn();
    const held = deferred();
    let resuming = false, actedWhileResuming = false, resume;
    const call = f.event('tool.call', { cwd: '/synthetic-project', tool: 'Agent', agentId: 'worker' },
      async () => { actedWhileResuming ||= resuming; return { context: ['original context'] }; });
    await started.promise;
    release.resolve();
    let chain = Promise.resolve();
    for (let i = 0; i < hops; i++) chain = chain.then(() => {});
    chain.then(() => {
      resuming = true;
      resume = f.event('agent.spawn', { resume: { agentId: 'worker' }, subagentType: 'other-agent' }, () => held.promise);
    });
    const result = await call;
    held.resolve({ agentId: 'worker' });
    await resume;
    assert.equal(actedWhileResuming, false, `a resume arriving ${hops} microtasks after the pre-act await must not meet an act`);
    outcomes.add(result.deny ? 'refused' : 'waived');
  }
  assert.deepEqual([...outcomes].sort(), ['refused', 'waived'], 'the scan must straddle the decision point');
});

test('a rule name that runs host code when formatted cannot run between the decision and the act', async () => {
  const { f, started, release } = pausedDecision();
  const held = deferred();
  let armed = false, resuming = false, actedWhileResuming = false, resume;
  const name = {
    [Symbol.toPrimitive]() {
      if (armed && !resume) {
        resuming = true;
        resume = f.event('agent.spawn', { resume: { agentId: 'worker' }, subagentType: 'other-agent' }, () => held.promise);
      }
      return 'sample.md';
    },
    endsWith: (suffix) => 'sample.md'.endsWith(suffix),
  };
  f.$.fs.list = async (dir) => dir === '/synthetic-config/rules-on-demand' ? [{ kind: 'file', name }] : [];
  await f.spawn();
  const call = f.event('tool.call', { cwd: '/synthetic-project', tool: 'Agent', agentId: 'worker' },
    async () => { actedWhileResuming ||= resuming; return { context: ['original context'] }; });
  await started.promise;
  armed = true;
  release.resolve();
  const result = await call;
  held.resolve({ agentId: 'worker' });
  await resume;
  assert.equal(actedWhileResuming, false, 'a rule name formatted after the decision must not run host code before the act');
  assertDelivered(result);
});

test('a list call that throws at once frees its host slot', async () => {
  const f = fixture();
  f.$.agent.list = () => { throw new Error('unavailable'); };
  for (let i = 0; i < 33; i++) assert.ok((await f.call({ agentId: `thrown-${i}` })).deny);
  f.$.agent.list = async () => [{ id: 'worker', type: 'my-agent' }];
  assertDelivered(await f.call({ agentId: 'worker' }));
});

// 254 fillers after A and B fill the sequence map; updating A keeps it first, so a new id evicts it at a high sequence.
async function heldPastFloor(f, first, second, held) {
  await f.spawn({ subagentType: first }, { model: 'synthetic', agentId: 'A' });
  if (second) await f.spawn({ subagentType: second }, { model: 'synthetic', agentId: 'B' });
  for (let i = 0; i < (second ? 254 : 255); i++) await f.spawn({ subagentType: 'other-agent' }, { model: 'synthetic', agentId: `filler-${i}` });
  const late = f.event('agent.spawn', { subagentType: held.type }, () => held.promise);
  await f.spawn({}, { model: 'synthetic', agentId: 'A' });
  await f.spawn({ subagentType: 'other-agent' }, { model: 'synthetic', agentId: 'C' });
  // Wrapped: an async function returning the bare promise would wait for it.
  return { late };
}

test('a late unlisted completion replaces an older listed type after another eviction', async () => {
  const f = fixture(), held = Object.assign(deferred(), { type: 'other-agent' });
  const { late } = await heldPastFloor(f, 'my-agent', 'my-agent', held);
  held.resolve({ model: 'synthetic', agentId: 'B' });
  await late;
  assert.ok((await f.call({ agentId: 'B' })).deny, 'newer unlisted evidence must not leave the older listed type standing');
});

test('a late listed completion replaces an older unlisted type after another eviction', async () => {
  const f = fixture(), held = Object.assign(deferred(), { type: 'my-agent' });
  const { late } = await heldPastFloor(f, 'my-agent', 'other-agent', held);
  held.resolve({ model: 'synthetic', agentId: 'B' });
  await late;
  assertDelivered(await f.call({ agentId: 'B' }));
});

test('a completion the floor cannot order forgets a looked-up type so a lookup refills it', async () => {
  const f = fixture(), held = Object.assign(deferred(), { type: 'my-agent' });
  const { late } = await heldPastFloor(f, 'my-agent', null, held);
  // Looked up after the fillers, so the type map's own bound cannot be what clears it.
  f.$.agent.list = async () => [{ id: 'B', type: 'other-agent' }];
  assert.ok((await f.call({ agentId: 'B' })).deny);
  await compact(f, 'B');
  f.$.agent.list = async () => [];
  assert.ok((await f.call({ agentId: 'B' })).deny, 'the looked-up unlisted type is cached');
  held.resolve({ model: 'synthetic', agentId: 'B' });
  await late;
  await compact(f, 'B');
  let requests = 0;
  f.$.agent.list = async () => { requests++; return [{ id: 'B', type: 'my-agent' }]; };
  assertDelivered(await f.call({ agentId: 'B' }));
  assert.equal(requests, 1, 'the unordered completion must have forgotten the cached type');
});

test('a timed-out lookup keeps its host slot until the request settles', async () => {
  const f = fixture(), pending = [];
  f.$.clock = { sleep: () => new Promise((resolve) => setTimeout(resolve, 2)) };
  f.$.agent.list = () => { const request = deferred(); pending.push(request); return request.promise; };
  try {
    for (let i = 0; i < 32; i++) assert.ok((await f.call({ agentId: `hung-${i}` })).deny);
    assert.ok((await f.call({ agentId: 'next' })).deny);
    assert.equal(pending.length, 32, 'requests past their deadline still occupy their host slot');
    pending[0].resolve([]);
    await new Promise((resolve) => setImmediate(resolve));
    assert.ok((await f.call({ agentId: 'after' })).deny);
    assert.equal(pending.length, 33, 'a settled request frees exactly one slot');
  } finally { for (const request of pending) request.resolve([]); }
  await new Promise((resolve) => setImmediate(resolve));
});

test('resumes past the spawning bound suspend every waiver until they settle', async () => {
  const f = fixture(), held = deferred();
  await f.spawn();
  const resumes = Array.from({ length: 257 }, (_, i) =>
    f.event('agent.spawn', { resume: { agentId: `resumed-${i}` }, subagentType: 'other-agent' }, () => held.promise));
  assert.ok((await f.call({ agentId: 'worker' })).deny, 'an untracked resume may concern any agent, so none is waived');
  held.resolve({ model: 'synthetic' });
  await Promise.all(resumes);
  await compact(f);
  // 257 new records evicted worker's own; a fresh spawn shows waivers are back.
  await f.spawn();
  assertDelivered(await f.call({ agentId: 'worker' }));
});

test('a spawn from before a reset neither records evidence nor clears a new resume mark', async () => {
  const f = fixture(), old = deferred(), current = deferred();
  const stale = f.event('agent.spawn', { resume: { agentId: 'worker' } }, () => old.promise);
  resetForSelftest();
  register((name, handler) => f.handlers.set(name, handler), { enabled: true });
  f.$.agent.list = async () => [{ id: 'worker', type: 'my-agent' }];
  const resume = f.event('agent.spawn', { resume: { agentId: 'worker' }, subagentType: 'my-agent' }, () => current.promise);
  old.resolve({ agentId: 'worker' });
  await stale;
  assert.ok((await f.call({ agentId: 'worker' })).deny, 'the new resume is still in flight');
  current.resolve({ agentId: 'worker' });
  await resume;
});

test('an old-session completion cannot record a type into the new session', async () => {
  const f = fixture(), old = deferred();
  const stale = f.event('agent.spawn', { subagentType: 'my-agent' }, () => old.promise);
  resetForSelftest();
  register((name, handler) => f.handlers.set(name, handler), { enabled: true });
  old.resolve({ model: 'synthetic', agentId: 'worker' });
  await stale;
  assert.ok((await f.call({ agentId: 'worker' })).deny, 'evidence from before the reset must not grant a waiver');
});

test('lookup backoff doubles to 60 seconds and success clears failure history', async () => {
  let now = 0, requests = 0;
  const f = fixture('my-agent', true, {}, 'decoy', Date.now, () => now);
  f.$.agent.list = async () => { requests++; return []; };
  for (const delay of [1000, 2000, 4000, 8000, 16000, 32000, 60000, 60000]) {
    const before = requests;
    assert.ok((await f.call({ agentId: 'worker' })).deny);
    assert.equal(requests, before + 1);
    await compact(f);
    now += delay - 1;
    assert.ok((await f.call({ agentId: 'worker' })).deny);
    assert.equal(requests, before + 1, `lookup must wait the entire ${delay} ms`);
    await compact(f);
    now++;
  }
  f.$.agent.list = async () => [{ id: 'worker', type: 'my-agent' }];
  assertDelivered(await f.call({ agentId: 'worker' }));
  await f.spawn({ subagentType: '' });
  await compact(f);
  f.$.agent.list = async () => { requests++; return []; };
  assert.ok((await f.call({ agentId: 'worker' })).deny);
  await compact(f);
  now += 1000;
  f.$.agent.list = async () => [{ id: 'worker', type: 'my-agent' }];
  assertDelivered(await f.call({ agentId: 'worker' }));
});

test('cycling 257 missing identities cannot evict a retry deadline', async () => {
  let now = 0;
  const f = fixture('my-agent', true, {}, 'decoy', Date.now, () => now);
  for (let i = 0; i < 257; i++) assert.ok((await f.call({ agentId: `missing-${i}` })).deny);
  assert.equal(f.lookups(), 256, 'with every retry slot holding a live deadline, a new identity sends no request');
  await compact(f, 'missing-0');
  assert.ok((await f.call({ agentId: 'missing-0' })).deny);
  assert.equal(f.lookups(), 256, 'the first identity must still wait out its deadline');
  await compact(f, 'missing-0');
  now = 1000;
  f.$.agent.list = async () => [{ id: 'missing-0', type: 'my-agent' }];
  assertDelivered(await f.call({ agentId: 'missing-0' }));
});

test('a lookup cannot fill a gap while a resume is in flight', async () => {
  const f = fixture(), started = deferred(), lookup = deferred(), spawn = deferred();
  f.$.agent.list = () => { started.resolve(); return lookup.promise; };
  const call = f.call({ agentId: 'worker' });
  await started.promise;
  const resume = f.event('agent.spawn', { resume: { agentId: 'worker' }, subagentType: '' }, () => spawn.promise);
  lookup.resolve([{ id: 'worker', type: 'my-agent' }]);
  assert.ok((await call).deny);
  spawn.resolve({ agentId: 'worker' });
  await resume;
  await compact(f);
  f.$.agent.list = async () => [];
  assert.ok((await f.call({ agentId: 'worker' })).deny, 'lookup must not survive an untyped resume');
});

test('a rejected resume clears its mark and forgets the previous occupant', async () => {
  const f = fixture(), failed = new Error('resume rejected');
  await f.spawn();
  await assert.rejects(() => f.event('agent.spawn', { resume: { agentId: 'worker' } }, async () => { throw failed; }), (error) => error === failed);
  assert.ok((await f.call({ agentId: 'worker' })).deny);
  await compact(f);
  await f.spawn();
  assertDelivered(await f.call({ agentId: 'worker' }));
});
