// A context counts a rule as served only when the conversation its next request is built from holds the rule's exact
// block; nothing on disk decides it. Context eviction is least-recently-used and a sub-agent's context ends with its turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { hostStore, hookFixture, bashRule, sandboxRoot } from './store-host-fake.mjs';

const PUSH = { command: 'git push origin main' };
const LIST = { command: 'ls' };
const served = (result) => JSON.stringify(result ?? {}).includes('<rule name=\\"sample.md\\">');
const idle = async () => ({});
// The trigger is wider than the governed act, so a serving call leaves its window open until the context ends.
const WIDE = bashRule.replace("window: '2'", "window: '500'").replace("act-regex: 'git push'", "act-regex: 'git push --force'");

async function sandbox(t) {
  const root = await sandboxRoot(t, 'rod-served-');
  return root;
}
const rows = (store) => String(store.map.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line));
const evicted = (store) => rows(store).filter((row) => row.reason === 'context evicted');
const turnEnd = (f, agentId) => f.handlers.get('turn.complete')(f.$, { cwd: f.project, agentId }, idle);

// The api form of a conversation: a rule block rides inside a tool result as a reminder, the way the host builds it.
const holding = (...texts) => [
  { role: 'user', content: [{ type: 'text', text: 'run it' }] },
  { role: 'assistant', content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'echo m' } }] },
  { role: 'user', content: [{ type: 'tool_result', tool_use_id: 't1', content: `m\n\n<system-reminder>\ntool.call hook additional context: ${texts.join('\n')}\n</system-reminder>` }] },
];
// A host whose conversations are fixtures: `main` for the main loop, `agents[id]` for a sub-agent; every call is recorded.
function conversations({ main = [], agents = {}, answer } = {}) {
  const calls = [];
  const messages = async (args) => {
    calls.push(args);
    if (answer) return answer(args);
    if (args?.as !== 'api') return [{ role: 'assistant' }];
    return args.agentId === undefined ? main : (agents[args.agentId] ?? []);
  };
  return { calls, messages, main, agents };
}
// What a fresh serving call hands the model: the rule's block exactly as the engine renders it.
async function servedBlock(t) {
  const f = await hookFixture(await sandbox(t), hostStore());
  const result = await f.call({ ...PUSH });
  assert.ok(served(result));
  return result.context[0];
}
const notices = (f) => f.logs.filter((line) => /conversation unavailable/.test(line));

test('A. restart: a fresh register over a conversation that holds the exact block does not serve it again', async (t) => {
  const block = await servedBlock(t);
  const world = conversations({ main: holding(block) });
  const f = await hookFixture(await sandbox(t), hostStore(), { messages: world.messages });
  assert.equal(served(await f.call({ ...PUSH })), false, 'already in the conversation');
  assert.deepEqual(world.calls.find((args) => args?.as === 'api'), { as: 'api' }, 'the main loop reads its own api messages');
  const empty = await hookFixture(await sandbox(t), hostStore(), { messages: conversations().messages });
  assert.ok(served(await empty.call({ ...PUSH })), 'control: an empty conversation serves');
});

test('B. a compaction summary that names the rule or paraphrases it does not count: the rule is served', async (t) => {
  const block = await servedBlock(t);
  const summary = holding('Summary: the rule sample.md (Check destination.) was served earlier.', block.replace('Check destination.', 'Check the destination.'),
    block.slice(0, -'</rule>'.length), block.replace('<rule name=', '<rule  name='));
  const f = await hookFixture(await sandbox(t), hostStore(), { messages: conversations({ main: summary }).messages });
  assert.ok(served(await f.call({ ...PUSH })), 'only the exact block counts');
});

test('C. a rule edited at the same path: the conversation holds the old body, the new body is served', async (t) => {
  const old = await servedBlock(t);
  const f = await hookFixture(await sandbox(t), hostStore(), { messages: conversations({ main: holding(old) }).messages });
  await writeFile(join(f.config, 'rules-on-demand', 'sample.md'), bashRule.replace('Check destination.', 'Check destination and branch.'));
  const result = await f.call({ ...PUSH });
  assert.ok(served(result), 'the edited rule is a different block');
  assert.ok(JSON.stringify(result).includes('Check destination and branch.'), 'the new body is the one served');
});

test('D. a sub-agent is judged by its own messages: its block counts for it, the main loop holding it does not', async (t) => {
  const block = await servedBlock(t);
  const world = conversations({ main: holding(block), agents: { x: holding(block) } });
  const f = await hookFixture(await sandbox(t), hostStore(), { messages: world.messages });
  assert.equal(served(await f.call({ ...PUSH })), false, 'main holds the block');
  assert.equal(served(await f.call({ ...PUSH, agentId: 'x' })), false, 'the agent holds the block in its own messages');
  assert.ok(served(await f.call({ ...PUSH, agentId: 'y' })), 'the main loop holding the block does not count for another agent');
  assert.deepEqual(world.calls.filter((args) => args?.agentId).map((args) => args), [{ as: 'api', agentId: 'x' }, { as: 'api', agentId: 'y' }]);
});

test('D. a sub-agent resumed after its turn ended is read again from its own messages', async (t) => {
  const block = await servedBlock(t);
  const world = conversations();
  const f = await hookFixture(await sandbox(t), hostStore(), { messages: world.messages });
  assert.ok(served(await f.call({ ...PUSH, agentId: 'x' })));
  await turnEnd(f, 'x');
  world.agents.x = holding(block);
  assert.equal(served(await f.call({ ...PUSH, agentId: 'x' })), false, 'its messages hold the block');
  await turnEnd(f, 'x');
  world.agents.x = [];
  assert.ok(served(await f.call({ ...PUSH, agentId: 'x' })), 'control: with nothing held it is served again');
});

test('E. messages that throw, refuse or return no list restore nothing: the rule is served, with one notice', async (t) => {
  const refusals = {
    throws: () => { throw new Error('transcript offline'); },
    deny: () => ({ deny: 'not readable' }),
    object: () => ({ messages: [] }),
  };
  for (const [label, answer] of Object.entries(refusals)) {
    const f = await hookFixture(await sandbox(t), hostStore(), { messages: conversations({ answer }).messages });
    assert.ok(served(await f.call({ ...PUSH })), `${label}: served`);
    assert.equal(served(await f.call({ ...PUSH })), false, `${label}: still once per context from memory`);
    assert.equal(notices(f).length, 1, `${label}: ${f.logs.join('\n')}`);
  }
});

test('F. two concurrent calls on a context being filled both wait for it', async (t) => {
  const block = await servedBlock(t);
  const world = conversations({ answer: async (args) => { await new Promise((resolve) => setTimeout(resolve, 100)); return args?.as === 'api' ? holding(block) : [{ role: 'assistant' }]; } });
  const f = await hookFixture(await sandbox(t), hostStore(), { messages: world.messages });
  const results = await Promise.all([f.call({ ...PUSH, agentId: 'late' }), f.call({ ...PUSH, agentId: 'late' })]);
  assert.deepEqual(results.map(served), [false, false]);
  assert.equal(world.calls.filter((args) => args?.agentId === 'late').length, 1, 'the conversation is read once per context');
});

test('G. eviction is least-recently-used: a context in use survives 70 newcomers, and an idle one is evicted', async (t) => {
  const store = hostStore();
  const f = await hookFixture(await sandbox(t), store);
  await writeFile(join(f.config, 'rules-on-demand', 'sample.md'), WIDE);
  assert.ok(served(await f.call({ ...PUSH })), 'main is served');
  assert.ok(served(await f.call({ ...PUSH, agentId: 'pilot' })), 'pilot is served');
  for (let n = 0; n < 70; n++) {
    await f.call({ ...PUSH, agentId: `other-${n}` });
    if (n % 10 === 9) await f.call({ ...LIST, agentId: 'pilot' });
  }
  const gone = evicted(store);
  assert.deepEqual(gone.filter((row) => row.agentId === 'pilot'), [], 'the pilot, used throughout, is never evicted');
  assert.deepEqual(gone.filter((row) => row.agentId === null), [], 'main is never evicted');
  assert.ok(gone.some((row) => row.agentId?.startsWith('other-')), 'an idle agent was evicted: the instrument can fail');
  assert.equal(served(await f.call({ ...PUSH, agentId: 'pilot' })), false, 'the pilot keeps its served set');
});

test('G. a sub-agent context ends with its turn: 70 finished agents never fill the map', async (t) => {
  const store = hostStore();
  const f = await hookFixture(await sandbox(t), store);
  await writeFile(join(f.config, 'rules-on-demand', 'sample.md'), WIDE);
  assert.ok(served(await f.call({ ...PUSH, agentId: 'pilot' })));
  for (let n = 0; n < 70; n++) {
    await f.call({ ...PUSH, agentId: `short-${n}` });
    await turnEnd(f, `short-${n}`);
  }
  assert.deepEqual(evicted(store), [], 'no context was evicted');
  assert.equal(served(await f.call({ ...PUSH, agentId: 'pilot' })), false, 'the pilot is still served');
});

test('a compaction forgets what the context held: the rule is served again, whatever the conversation read earlier says', async (t) => {
  const block = await servedBlock(t);
  const f = await hookFixture(await sandbox(t), hostStore(), { messages: conversations({ main: holding(block) }).messages });
  assert.equal(served(await f.call({ ...PUSH })), false, 'held before the compaction');
  await f.handlers.get('session.compact')(f.$, { cwd: f.project }, idle);
  assert.ok(served(await f.call({ ...PUSH })), 'the compaction cleared the set and the old read is not consulted again');
});

test('H. a compaction that lands while the conversation is still being read leaves nothing held from that read', async (t) => {
  const block = await servedBlock(t);
  const world = conversations({ answer: async (args) => { await new Promise((resolve) => setTimeout(resolve, 150)); return args?.as === 'api' ? holding(block) : [{ role: 'assistant' }]; } });
  const f = await hookFixture(await sandbox(t), hostStore(), { messages: world.messages });
  const call = f.call({ ...PUSH });
  await new Promise((resolve) => setTimeout(resolve, 20));
  await f.handlers.get('session.compact')(f.$, { cwd: f.project }, idle);
  assert.ok(served(await call), 'the read began before the compaction: it describes a conversation that no longer exists');
});
