import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import * as hooks from '../hooks/hooks.js';

const rule = (name, trigger = 'Agent', before = false) => [
  '---', 'on-demand:', '  triggers:', '    - kind: tool', `      tool: ^${trigger}$`, '      unconditional: true',
  ...(before ? ['      before-first-act: true'] : []), '  compliance:', '    kind: bash-command', '    act-regex: git push',
  '    require-regex: origin', '    window: 100', '    on-close: not applicable', '---', `Follow ${name}.`, '',
].join('\n');

function host(files) {
  hooks.resetForSelftest();
  const handlers = new Map(), stored = new Map();
  hooks.register((name, handler) => handlers.set(name, handler), { enabled: true });
  const entries = new Map(Object.entries(files).map(([name, text]) => [`/config/rules-on-demand/${name}`, text]));
  const $ = {
    env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: '/config', HOME: '/home' })[name] },
    fs: { list: async (path) => [...entries.keys()].filter((key) => key.startsWith(`${path}/`)).map((key) => ({ kind: 'file', name: key.slice(path.length + 1) })), read: async (path) => entries.get(path), stat: async (path) => ({ kind: entries.has(path) ? 'file' : 'dir', size: entries.get(path)?.length ?? 0, realPath: path }) },
    ui: { log: async () => {} }, store: { get: async (key) => stored.get(key), set: async (key, value) => stored.set(key, value) },
    session: { id: async () => 's', messages: async () => [{ role: 'assistant' }] }, model: { classify: async () => 'followed' },
  };
  const event = (name, e = {}, next = async () => ({})) => handlers.get(name)($, { cwd: '/p', ...e }, next);
  const entriesOf = () => Object.values(stored.get('sessions')?.s?.contexts ?? {}).flatMap((ctx) => ctx.complianceInjected ?? []);
  const rows = () => String(stored.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { $, stored, event, entriesOf, rows };
}

test('two windows served by one call have unique ids, and window rows match journal identity', async () => {
  const f = host({ 'a.md': rule('a'), 'b.md': rule('b') });
  await f.event('tool.call', { tool: 'Agent' });
  await f.event('turn.complete');
  assert.equal(new Set(f.entriesOf().map((item) => item.deliveryId)).size, 2, 'each injected window gets a distinct delivery id');
  for (const entry of f.entriesOf()) {
    assert.ok(Number.isFinite(entry.deliverySeq));
    assert.ok(Number.isFinite(entry.servingSeq));
    const row = f.rows().find((item) => item.rule === entry.rule);
    assert.deepEqual([row.deliveryId, row.deliverySeq, row.servingSeq], [entry.deliveryId, entry.deliverySeq, entry.servingSeq], 'window row uses journal delivery fields');
    assert.ok(row.verdictId && Number.isFinite(row.actSeq));
  }
  assert.ok(f.stored.get('sessions').s.contexts['0'].lastClose, 'turn end records a close marker');
});

test('served per-act verdict discharges the freshly dropped window', async () => {
  const f = host({ 'r.md': rule('r', 'Bash') });
  await f.event('tool.call', { tool: 'Bash', command: 'git push origin' });
  const row = f.rows()[0], served = f.entriesOf()[0];
  assert.ok(row.verdictId && Number.isFinite(row.actSeq));
  assert.equal(row.deliveryId, undefined, 'per-act row is not a window row');
  assert.equal(row.discharged?.[0]?.deliveryId, served.deliveryId, 'per-act verdict names the window it ended');
});

test('admission is source-locked before the first suspension in both tool and prompt handlers', async () => {
  const source = await readFile(new URL('../hooks/hooks.js', import.meta.url), 'utf8');
  for (const name of ['toolCallWork', 'promptSubmitWork']) {
    const body = source.slice(source.indexOf(`async function ${name}(`));
    assert.match(body.slice(0, body.indexOf('await')), /const admission = \+\+sequence/, `${name}: admission must be before its first await`);
  }
});

test('a later-admitted call cannot claim a window injected by an earlier still-running call', async () => {
  const f = host({ 'r.md': rule('r') });
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  const serving = f.event('tool.call', { tool: 'Agent' }, async () => { entered(); await hold; return {}; });
  await ready;
  let releaseAct;
  const holdAct = new Promise((resolve) => { releaseAct = resolve; });
  let actEntered;
  const actReady = new Promise((resolve) => { actEntered = resolve; });
  const act = f.event('tool.call', { tool: 'Bash', command: 'git push origin' }, async () => { actEntered(); await holdAct; return {}; });
  await actReady;
  release();
  await serving;
  releaseAct();
  await Promise.all([serving, act]);
  const served = f.entriesOf()[0];
  const judged = f.rows().find((row) => row.deliveryId === served.deliveryId || row.discharged?.some((item) => item.deliveryId === served.deliveryId));
  assert.ok(served.deliverySeq > judged.actSeq, 'serve after the act admission must be distinguishable');
  assert.notEqual(judged.actSeq, served.servingSeq);
});

test('concurrent refusals can discharge the second window on retry', async () => {
  const f = host({ 'r.md': rule('r', 'Bash', true) });
  let release;
  const hold = new Promise((resolve) => { release = resolve; });
  let entered;
  const ready = new Promise((resolve) => { entered = resolve; });
  f.$.ui.log = async () => { entered(); await hold; };
  const one = f.event('tool.call', { tool: 'Bash', command: 'git push origin' });
  await ready;
  const two = f.event('tool.call', { tool: 'Bash', command: 'git push origin' });
  release();
  await Promise.all([one, two]);
  await f.event('tool.call', { tool: 'Bash', command: 'git push origin' });
  assert.ok(f.rows().some((row) => row.discharged?.some((item) => item.deliveryId === f.entriesOf()[1]?.deliveryId)), 'retry carries the other refused window');
});

test('compaction and eviction mark their own closed contexts without advancing on a verdict write', async () => {
  const f = host({ 'r.md': rule('r') });
  await f.event('tool.call', { tool: 'Agent' });
  await f.event('tool.call', { tool: 'Bash', command: 'git push origin' });
  assert.equal(f.stored.get('sessions').s.contexts['0'].lastClose, undefined, 'verdict writes do not mark a lifecycle close');
  await f.event('session.compact');
  assert.ok(f.stored.get('sessions').s.contexts['0'].lastClose?.seq > f.entriesOf()[0].deliverySeq);
  await f.event('tool.call', { tool: 'Agent', agentId: 'first' });
  for (let index = 1; index < 65; index++) await f.event('tool.call', { tool: 'Read', agentId: `agent-${index}` });
  assert.ok(f.stored.get('sessions').s.contexts['agent:first'].lastClose?.seq > f.stored.get('sessions').s.contexts['agent:first'].complianceInjected[0].deliverySeq,
    'eviction closes the detached agent context');
});
