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
// through $.env.get. A decoy in process.env proves the module never reads it from there.
function fixture(config = 'my-agent', enabled = true, options = {}, decoy = 'decoy-type') {
  resetForSelftest();
  process.env.WT_ROD_NO_REFUSE_AGENT_TYPES = decoy;
  const handlers = new Map(), store = new Map(), logs = [], envReads = [];
  let lookups = 0, acts = 0;
  register((name, handler) => handlers.set(name, handler), { enabled, ...options });
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
});

test('unknown id stays refused when list throws, and is looked up only once', async () => {
  const f = fixture();
  let lookups = 0;
  f.$.agent.list = async () => { lookups++; throw new Error('unavailable'); };
  assert.ok((await f.call({ agentId: 'unknown' })).deny);
  await f.event('session.compact', { agentId: 'unknown' }, async () => ({}));
  assert.ok((await f.call({ agentId: 'unknown' })).deny);
  assert.equal(lookups, 1);
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
  test(`absent or empty configuration learns nothing and looks nothing up: ${JSON.stringify(config)}`, async () => {
    const f = fixture(config);
    await f.spawn();
    assert.ok((await f.call({ agentId: 'worker' })).deny);
    assert.equal(f.lookups(), 0);
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
  f.$.agent.list = async () => [{ id: 'worker', type: 'lean-probe' }];
  assert.ok((await f.call({ agentId: 'worker' })).deny);
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
});

test('plugin options no longer exempt an agent type when the env setting is absent', async () => {
  const f = fixture(null, true, { no_refuse_agent_types: ['lean-probe'] });
  await f.spawn({ subagentType: 'lean-probe' });
  f.$.agent.list = async () => [{ id: 'worker', type: 'lean-probe' }];
  assert.ok((await f.call({ agentId: 'worker' })).deny, 'plugin options must not exempt the type');
  assert.equal(f.lookups(), 0);
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
});

test('spawn bookkeeping cannot fail an otherwise successful spawn', async () => {
  const f = fixture();
  const input = { get subagentType() { throw new Error('metadata unavailable'); } };
  const result = { model: 'synthetic', agentId: 'worker' };
  assert.equal(await f.handlers.get('agent.spawn')(f.$, input, async () => result), result);
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
  f.$.agent.list = () => new Promise(() => {});
  assert.ok((await f.call({ agentId: 'worker' })).deny);
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
