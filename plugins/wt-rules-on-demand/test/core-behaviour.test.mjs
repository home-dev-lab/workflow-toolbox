import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
const { register, resetForSelftest } = await import(process.env.ROD_TEST_HOOKS ? pathToFileURL(process.env.ROD_TEST_HOOKS).href : '../hooks/hooks.js');
const { rollbackDecision } = await import(process.env.ROD_TEST_LIFECYCLE ? pathToFileURL(process.env.ROD_TEST_LIFECYCLE).href : '../scripts/rule-lifecycle-lib.mjs');

const makeRule = (compliance = "    kind: 'none'\n    reason: 'fixture'", trigger = "    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: 'true'") => `---\non-demand:\n  triggers:\n${trigger}\n  compliance:\n${compliance}\n---\nSynthetic instruction.\n`;

function fixture(rule = makeRule()) {
  resetForSelftest();
  const handlers = new Map();
  const store = new Map();
  let messages = [{ role: 'assistant' }];
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  const $ = {
    env: { get: async (key) => key === 'CLAUDE_CONFIG_DIR' ? '/synthetic-config' : undefined },
     fs: { list: async (dir) => dir === '/synthetic-config/rules-on-demand' ? [{ kind: 'file', name: 'sample.md' }] : [], read: async () => rule,
       stat: async (path) => ({ kind: 'file', size: rule.length, realPath: path }) },
    ui: { log: async () => {} },
    session: { id: async () => 'synthetic-session', messages: async () => messages },
    store: { get: async (key) => store.get(key), set: async (key, value) => store.set(key, value) },
    model: { classify: async () => 'followed' },
  };
  const event = (name, args = {}, next = async () => ({})) => handlers.get(name)($, { cwd: '/synthetic-project', ...args }, next);
  const call = (args = {}) => event('tool.call', { tool: 'Agent', ...args });
  const verdicts = () => String(store.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
  return { $, event, call, verdicts, setMessages: (value) => { messages = value; } };
}

test('compaction resets only its loop, skip resets neither, main resets main', async () => {
  const f = fixture();
  assert.ok((await f.call()).deny);
  assert.ok((await f.call({ agentId: 'worker' })).deny);
  await f.event('session.compact', { agentId: 'worker' }, async () => ({ skip: true }));
  assert.equal((await f.call({ agentId: 'worker' })).deny, undefined, 'skipped compaction retains subagent state');
  await f.event('session.compact', { agentId: 'worker' });
  assert.equal((await f.call()).deny, undefined, 'subagent compaction does not reset main');
  assert.ok((await f.call({ agentId: 'worker' })).deny, 'subagent compaction resets worker');
  await f.event('session.compact');
  assert.ok((await f.call()).deny, 'main compaction resets main');
  assert.equal((await f.call({ agentId: 'worker' })).deny, undefined, 'main compaction leaves worker served');
});

test('fresh prompt context resets main; assistant history preserves served state', async () => {
  const f = fixture();
  assert.ok((await f.call()).deny);
  await f.event('prompt.context');
  assert.equal((await f.call()).deny, undefined, 'assistant history retains state');
  f.setMessages([]);
  await f.event('prompt.context');
  assert.ok((await f.call()).deny, 'fresh conversation resets main');
  assert.equal((await f.call()).deny, undefined);
});

test('subagent serve-once is independent of main and of other subagents', async () => {
  const f = fixture();
  assert.ok((await f.call({ agentId: 'one' })).deny);
  assert.equal((await f.call({ agentId: 'one' })).deny, undefined);
  assert.ok((await f.call()).deny);
  assert.ok((await f.call({ agentId: 'two' })).deny);
  assert.equal((await f.call()).deny, undefined);
});

const bashTrigger = "    - kind: 'prompt'\n      regex: 'audit'";
const bashCompliance = (requirement) => `    kind: 'bash-command'\n    window: '3'\n    on-close: 'not applicable'\n    act-regex: 'deploy'\n    ${requirement}`;
for (const [name, requirement] of [['require-regex', "require-regex: 'approved'"], ['require-all', "require-all: 'approved||staging'"]]) {
  test(`bash-command ${name} records both outcomes and on-close when no governed act occurs`, async () => {
    const f = fixture(makeRule(bashCompliance(requirement), bashTrigger));
    await f.event('prompt.submit', { text: 'audit' });
    await f.event('tool.call', { tool: 'Bash', command: 'deploy approved staging' });
    await f.event('session.compact');
    await f.event('prompt.submit', { text: 'audit' });
    await f.event('tool.call', { tool: 'Bash', command: 'deploy staging' });
    await f.event('session.compact');
    await f.event('prompt.submit', { text: 'audit' });
    await f.event('turn.complete');
    assert.deepEqual(f.verdicts().map((row) => row.verdict), ['followed', 'not followed', 'not applicable']);
  });
}

test('bash-command window expires without a governed act', async () => {
  const f = fixture(makeRule(bashCompliance("require-regex: 'approved'"), bashTrigger));
  await f.event('prompt.submit', { text: 'audit' });
  for (let i = 0; i < 3; i++) await f.event('tool.call', { tool: 'Bash', command: `inspect ${i}` });
  assert.deepEqual(f.verdicts().map((row) => row.verdict), ['not applicable']);
  await f.event('turn.complete');
  assert.equal(f.verdicts().length, 1, 'closing an expired window must not write twice');
});

test('test-before-edit measures test then edit versus edit before test', async () => {
  const f = fixture(makeRule("    kind: 'test-before-edit'\n    window: '3'\n    on-close: 'not applicable'\n    test-regex: 'npm test'\n    path-regex: 'sample\\.js'", bashTrigger));
  await f.event('prompt.submit', { text: 'audit' });
  await f.event('tool.call', { tool: 'Bash', command: 'npm test' });
  await f.event('tool.call', { tool: 'Edit', path: 'sample.js' });
  await f.event('session.compact');
  await f.event('prompt.submit', { text: 'audit' });
  await f.event('tool.call', { tool: 'Edit', path: 'sample.js' });
  assert.deepEqual(f.verdicts().map((row) => row.verdict), ['followed', 'not followed']);
});

test('model classifier failure closes as unknown with error reason', async () => {
  const f = fixture(makeRule("    kind: 'model'\n    model: 'synthetic'\n    prompt: 'assess'\n    window: '2'\n    on-close: 'not applicable'", bashTrigger));
  f.$.model.classify = async () => { throw new Error('classifier unavailable'); };
  await f.event('prompt.submit', { text: 'audit' });
  await f.event('turn.complete');
  assert.deepEqual(f.verdicts().map((row) => [row.verdict, row.reason]), [['unknown', 'classifier unavailable']]);
});

test('rollback decision threshold, minimum and trigger miss precedence', () => {
  const insufficient = rollbackDecision({ followed: 0, applicable: 4, threshold: 0.8, minimum: 5 });
  assert.equal(insufficient.reason, '');
  assert.equal(insufficient.recommendation, '');
  // Owner decision: revert ONLY when on demand is followed less than static, both measured on the minimum samples.
  const noBaseline = rollbackDecision({ followed: 0, applicable: 5, beforeFollowed: 0, beforeApplicable: 4, threshold: 0.8, minimum: 5 });
  assert.equal(noBaseline.attention, true);
  assert.match(noBaseline.reason, /no static baseline/);
  const worse = rollbackDecision({ followed: 2, applicable: 5, beforeFollowed: 4, beforeApplicable: 5, threshold: 0.8, minimum: 5 });
  assert.equal(worse.attention, false);
  assert.match(worse.reason, /40\.0% below static 80\.0%/);
  assert.match(worse.recommendation, /reinstate as static/);
  // Below the old arbitrary 80% threshold, but better than static: kept, no revert, no attention.
  const betterThanStatic = rollbackDecision({ followed: 3, applicable: 5, beforeFollowed: 1, beforeApplicable: 5, threshold: 0.8, minimum: 5 });
  assert.equal(betterThanStatic.reason, '');
  assert.equal(betterThanStatic.attention, false);
  assert.equal(rollbackDecision({ followed: 2, applicable: 5, beforeFollowed: 2, beforeApplicable: 5, minimum: 5 }).reason, '');
  const miss = rollbackDecision({ triggerMiss: true, followed: 1, applicable: 10, beforeFollowed: 2, beforeApplicable: 10 });
  assert.match(miss.reason, /trigger miss/);
  assert.match(miss.recommendation, /Fix the trigger/);
});
