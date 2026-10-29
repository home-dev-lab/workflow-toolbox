import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, resetForSelftest } from '../hooks/hooks.js';
import { joinDeliveries, journalDeliveries } from '../scripts/delivery-join.mjs';

const model = '    kind: model\n    model: haiku\n    prompt: Judge the action\n    window: 1\n    on-close: not applicable';
const bash = '    kind: bash-command\n    act-regex: git push\n    require-regex: origin\n    exempt-regex: --dry-run\n    window: 1\n    on-close: not applicable';
const trigger = '    - kind: tool\n      tool: ^Bash$\n      unconditional: true';
const text = (compliance, triggers = trigger) => `---\non-demand:\n  triggers:\n${triggers}\n  compliance:\n${compliance}\n---\nFollow the action rule.\n`;

function host(compliance = model, triggers = trigger, held = []) {
  resetForSelftest();
  const handlers = new Map(), store = new Map(), prompts = [];
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  const source = text(compliance, triggers);
  const $ = {
    env: { get: async (name) => name === 'CLAUDE_CONFIG_DIR' ? '/config' : undefined },
    fs: { list: async (path) => path === '/config/rules-on-demand' ? [{ name: 'r.md', kind: 'file' }] : [],
      read: async () => source, stat: async (path) => ({ kind: 'file', realPath: path, size: source.length }) },
    session: { id: async () => 's', root: async () => '/project', messages: async () => held },
    store: { get: async (key) => store.get(key), set: async (key, value) => store.set(key, value) },
    ui: { log: async () => {} }, model: { classify: async (prompt) => { prompts.push(prompt); return 'followed'; } },
  };
  const event = (name, e = {}, next = async () => ({})) => handlers.get(name)($, { cwd: '/project', ...e }, next);
  const call = (e = {}, next) => event('tool.call', { tool: 'Bash', command: 'git push origin', ...e }, next);
  const rows = () => String(store.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);
  const deliveries = () => journalDeliveries(store.get('sessions'));
  return { $, prompts, event, call, rows, deliveries, store };
}

for (const ending of ['turn.complete', 'session.compact']) {
  test(`empty model window labels no act without a judge at ${ending}`, async () => {
    const f = host(model, '    - kind: prompt\n      regex: ready');
    await f.event('prompt.submit', { text: 'ready' });
    await f.event(ending);
    assert.equal(f.prompts.length, 0, 'an empty window never calls the judge');
    assert.equal(f.rows()[0].applicability, 'no act');
    assert.equal(f.rows()[0].later, false);
  });
}

test('exhausted declarative window distinguishes no act from a real exemption', async () => {
  const f = host(bash, '    - kind: tool\n      tool: ^Agent$\n      unconditional: true');
  await f.call({ tool: 'Agent' });
  await f.call({ tool: 'Read', input: { file_path: 'notes.txt' } });
  await f.call({ command: 'git push --dry-run' });
  assert.deepEqual(f.rows().map((row) => row.applicability), ['no act', 'not applicable']);
  assert.equal(f.rows()[1].later, true);
  assert.equal(f.rows()[1].servedDeliveryId, f.deliveries()[0].deliveryId);
});

for (const [answer, expected] of [
  ['followed', 'applicable'], ['not followed', 'applicable'],
  ['not applicable', 'not applicable'], ['unknown', 'unknown'], ['unexpected', 'unknown'],
]) {
  test(`model applicability labels ${answer}`, async () => {
    const f = host();
    f.$.model.classify = async () => answer;
    await f.call();
    await f.event('turn.complete');
    assert.equal(f.rows()[0].applicability, expected);
  });
}

test('unregistered checks and judge failures have unknown applicability', async () => {
  const missing = host('    kind: check\n    check: missing-check');
  await missing.call();
  assert.equal(missing.rows()[0].applicability, 'unknown');
  const failed = host();
  failed.$.model.classify = async () => { throw new Error('judge unavailable'); };
  await failed.call();
  await failed.event('turn.complete');
  assert.equal(failed.rows()[0].applicability, 'unknown');
  assert.equal(failed.rows()[0].reason, 'judge unavailable');
});

test('next-call exhaustion labels no act but a matching call is applicable', async () => {
  const compliance = '    kind: next-call\n    tool: ^LSP$\n    require-tool: ^LSP$\n    window: 1\n    on-close: not applicable';
  const f = host(compliance);
  await f.call();
  await f.call({ tool: 'Read' });
  assert.equal(f.rows()[0].applicability, 'no act');
  await f.event('session.compact');
  await f.call();
  await f.call({ tool: 'LSP' });
  assert.equal(f.rows()[1].applicability, 'applicable');
});

test('later model acts each open a measured window without serving text or delivery claims', async () => {
  const f = host(model.replace('window: 1', 'window: 2'));
  assert.match((await f.call({ command: 'git push origin first' })).context[0], /action rule/);
  for (const suffix of ['second', 'third']) assert.deepEqual(await f.call({ command: `git push origin ${suffix}` }), {});
  await f.call({ tool: 'Read', input: { file_path: 'fourth.txt' } });
  await f.event('turn.complete');
  assert.equal(f.prompts.length, 3, 'each matching act has a model window');
  assert.ok(f.prompts.some((prompt) => !/first/.test(prompt) && /second[\s\S]*third[\s\S]*fourth/.test(prompt)),
    'a later window keeps the configured two following calls');
  assert.deepEqual(f.rows().map((row) => row.later), [false, true, true]);
  for (const row of f.rows().slice(1)) {
    assert.equal(row.servedDeliveryId, f.deliveries()[0].deliveryId);
    assert.equal(row.deliveryId, undefined, 'measurement is not a new delivery');
  }
  assert.equal(f.deliveries().length, 1);
  const joined = joinDeliveries(f.rows(), f.deliveries());
  assert.equal(joined.rows.length, 3, 'reader keeps later records');
  assert.equal(joined.duplicateRows.length, 0);
});

test('refused attempt and unchanged retry are one model act, followed by a later measurement', async () => {
  const f = host(model, `${trigger}\n      before-first-act: true`);
  let executed = 0;
  const next = async () => { executed++; return {}; };
  assert.match((await f.call({}, next)).deny, /action rule/);
  assert.equal(executed, 0);
  assert.deepEqual(f.rows(), []);
  assert.deepEqual(await f.call({}, next), {});
  await f.event('turn.complete');
  assert.equal(f.rows().length, 1, 'retry must not open a duplicate later window');
  assert.equal(f.rows()[0].later, false);
  await f.call({}, next);
  await f.event('turn.complete');
  assert.equal(f.rows().length, 2, 'second executed act is measured');
  assert.equal(f.rows()[1].later, true);
  assert.equal(f.rows()[1].servedDeliveryId, f.deliveries()[0].deliveryId);
  assert.equal(executed, 2);
  assert.equal(f.store.get('sessions').s.contexts[0].governedActs[0].count, 2);
});

test('declarative and registered checks label first and later measurements', async () => {
  for (const compliance of [bash, '    kind: check\n    check: gate-background']) {
    const f = host(compliance);
    const act = compliance === bash ? {} : { command: 'pnpm test', input: { command: 'pnpm test', run_in_background: true } };
    await f.call(act);
    await f.call(act);
    assert.deepEqual(f.rows().map((row) => row.later), [false, true]);
    assert.deepEqual(f.rows().map((row) => row.applicability), ['applicable', 'applicable']);
    assert.equal(f.rows()[1].servedDeliveryId, f.deliveries()[0]?.deliveryId ?? null);
  }
});

test('conversation-held model rule measures a later act with a null delivery reference', async () => {
  const f = host(model, trigger, [{ role: 'user', content: '<rule name="r.md">\nFollow the action rule.\n\n</rule>' }]);
  assert.deepEqual(await f.call(), {});
  await f.event('turn.complete');
  assert.equal(f.rows().length, 1);
  assert.equal(f.rows()[0].later, true);
  assert.equal(f.rows()[0].servedDeliveryId, null);
});

test('compaction and agent contexts independently refuse and link their own later measurements', async () => {
  const f = host(model, `${trigger}\n      before-first-act: true`);
  for (const agentId of [undefined, 'worker']) {
    assert.match((await f.call({ agentId })).deny, /action rule/);
    await f.call({ agentId });
    await f.call({ agentId });
  }
  await f.event('session.compact');
  assert.match((await f.call()).deny, /action rule/);
  await f.call();
  await f.event('turn.complete');
  await f.event('turn.complete', { agentId: 'worker' });
  const later = f.rows().filter((row) => row.later);
  assert.equal(later.length, 2);
  assert.notEqual(later[0].servedDeliveryId, later[1].servedDeliveryId);
  assert.deepEqual(new Set(later.map((row) => row.agentId)), new Set([null, 'worker']));
});

test('a named check refused first labels its executed retry as the initial record', async () => {
  const f = host('    kind: check\n    check: gate-background', `${trigger}\n      before-first-act: true`);
  const act = { command: 'pnpm test', input: { command: 'pnpm test', run_in_background: true } };
  assert.match((await f.call(act)).deny, /action rule/);
  await f.call(act);
  await f.call(act);
  assert.deepEqual(f.rows().map((row) => row.later), [false, true]);
});

test('turn-correlation records label repeated turns as later measurements', async () => {
  const correlation = "    kind: turn-correlation\n    tool: ^Agent$\n    id-regex: 'agentId: (\\w+)'\n    value-regex: 'id: (\\w+)'\n    follow-up-tool: ^SendMessage$\n    min-distinct: 1\n    window: 1\n    on-close: not applicable";
  const f = host(correlation, '    - kind: prompt\n      regex: enable');
  await f.event('prompt.submit', { text: 'enable' });
  for (const id of ['a', 'b']) {
    await f.call({ tool: 'Agent', tool_use_id: id });
    await f.event('turn.complete');
  }
  assert.deepEqual(f.rows().map((row) => row.later), [false, true]);
});
