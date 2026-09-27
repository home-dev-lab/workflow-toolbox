import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, resetForSelftest, parseRuntimeRule } from '../hooks/hooks.js';
import { ruleDirectories, configDirectory } from '../paths.js';

const rule = (before = false) => `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: '${before}'\n  compliance:\n    kind: 'none'\n    reason: 'no mechanical check'\n---\nFollow this rule.\n`;
function fixture({ options = { enabled: true }, staticNames = [], userNames = ['sample.md'], projectNames = [] } = {}) {
  resetForSelftest();
  const handlers = new Map();
  register((event, handler) => handlers.set(event, handler), options);
  const paths = ruleDirectories('/sample-project', '/sample-config');
  const files = new Map([
    ...userNames.map((name) => [`${paths.user}/${name}`, rule(true)]),
    ...projectNames.map((name) => [`${paths.project}/${name}`, rule(true)]),
     ...staticNames.map((name) => [`${paths.projectStatic}/wt/${name}`, 'Follow this rule.\n']),
  ]);
  const stored = new Map();
  const logs = [];
  const $ = {
    env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: '/sample-config', HOME: '/sample-home' })[name] },
    fs: { list: async (dir) => {
      const results = new Map();
      for (const path of files.keys()) if (path.startsWith(`${dir}/`)) {
        const suffix = path.slice(dir.length + 1);
        const name = suffix.split('/')[0];
         results.set(name, { kind: suffix.includes('/') ? 'dir' : 'file', name });
      }
      return [...results.values()];
     }, read: async (path) => files.get(path), stat: async (path) => ({ kind: files.has(path) ? 'file' : 'dir', size: files.get(path)?.length ?? 0, realPath: path }) },
    ui: { log: async (line) => { logs.push(line); } },
    store: { get: async (name) => stored.get(name), set: async (name, value) => stored.set(name, value) },
    session: { id: async () => 'sample-session', messages: async () => [] },
  };
  const call = (event, next = async () => ({})) => handlers.get('tool.call')($, { tool: 'Agent', cwd: '/sample-project', ...event }, next);
   return { call, $, logs, stored, files, handlers };
}

test('prompt context is delivered through next and rejected prompts are not claimed', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: 'false'", "kind: 'prompt'\n      regex: 'ready'"));
  let received;
  const prompt = (result) => f.handlers.get('prompt.submit')(f.$, { text: 'ready', cwd: '/sample-project', context: ['prior'] }, async (event) => { received = event; return result; });
  assert.deepEqual(await prompt({ drop: true }), { drop: true });
  assert.match(received.context[1], /Follow this rule/);
  assert.equal(f.stored.get('served'), undefined);
  assert.deepEqual(await prompt({ ok: true }), { ok: true });
  assert.match(received.context[1], /Follow this rule/);
  assert.equal(f.stored.get('served')['sample.md'].count, 1);
  assert.deepEqual(await prompt({ ok: true }), { ok: true });
  assert.deepEqual(received.context, ['prior']);
});
test('concurrent matching prompts deliver only one claimed context', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: 'false'", "kind: 'prompt'\n      regex: 'ready'"));
  let release;
  const waiting = new Promise((resolve) => { release = resolve; });
  const delivered = [];
  const submit = () => f.handlers.get('prompt.submit')(f.$, { text: 'ready', cwd: '/sample-project' }, async (input) => { delivered.push(input.context ?? []); await waiting; return {}; });
  const one = submit(), two = submit();
  while (delivered.length < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await Promise.all([one, two]);
  assert.deepEqual(delivered.map((context) => context.length).sort(), [0, 1]);
  assert.equal(f.stored.get('served')['sample.md'].count, 1);
});

test('full context map closes pending verdicts on eviction', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'none'\n    reason: 'no mechanical check'", "kind: 'bash-command'\n    window: '100'\n    on-close: 'not applicable'\n    act-regex: 'git push'\n    require-regex: 'origin'"));
  for (let i = 0; i < 66; i++) await f.call({ agentId: `agent-${i}` });
  const rows = String(f.stored.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(rows[0]?.reason, 'context evicted');
  assert.equal(rows[0]?.agentId, 'agent-0');
});

test('disabled with no files passes through, no journal', async () => {
  const f = fixture({ options: { enabled: false }, userNames: [] });
  let calls = 0;
  assert.deepEqual(await f.call({}, async () => { calls++; return { ok: true }; }), { ok: true });
  assert.equal(calls, 1);
  assert.equal(f.stored.size, 0);
});
test('disabled with a matching file passes through; enabling serves it', async () => {
  const off = fixture({ options: { enabled: false } });
  let calls = 0;
  assert.deepEqual(await off.call({}, async () => { calls++; return {}; }), {});
  assert.equal(calls, 1);
  assert.equal(off.stored.size, 0);
  const on = fixture({ options: { enabled: true } });
  assert.match((await on.call({})).deny, /Follow this rule/);
});
test('two matching calls in flight refuse, retry passes exactly once', async () => {
  const f = fixture();
  let calls = 0;
  const next = async () => { calls++; return {}; };
  const [first, second] = await Promise.all([f.call({}, next), f.call({}, next)]);
  assert.match(first.deny, /Follow this rule/);
  assert.match(second.deny, /Follow this rule/);
  assert.equal(calls, 0);
  await f.call({}, next);
  assert.equal(calls, 1);
});
test('failed refusal logging does not mark the rule served or invoke next', async () => {
  const f = fixture();
  const log = f.$.ui.log;
  f.$.ui.log = async () => { throw new Error('log unavailable'); };
  let executed = 0;
  await assert.rejects(() => f.call({}, async () => { executed++; return {}; }), /log unavailable/);
  f.$.ui.log = log;
  assert.match((await f.call({}, async () => { executed++; return {}; })).deny, /Follow this rule/);
  assert.equal(executed, 0);
});
test('duplicate static basename blocks delivery across scopes', async () => {
  const f = fixture({ staticNames: ['sample.md'] });
  assert.deepEqual(await f.call({}), {});
  assert.match(f.logs.join('\n'), /loaded twice: .*sample\.md and .*sample\.md; the on-demand copy is not served/);
});
test('nested user static rule blocks a project on-demand copy', async () => {
  const f = fixture({ userNames: [], projectNames: ['sample.md'] });
   f.files.set('/sample-config/rules/nested/deep/sample.md', 'Follow this rule.\n');
  assert.deepEqual(await f.call({}), {});
  assert.match(f.logs.join('\n'), /nested\/deep\/sample.md and .*rules-on-demand\/sample.md/);
});
test('frontmatter refuses unknown keys and degrades unregistered check names', () => {
  assert.throws(() => parseRuntimeRule('sample.md', rule().replace('unconditional:', 'unrecognised:')), /unknown trigger key/);
  assert.equal(parseRuntimeRule('sample.md', rule().replace("kind: 'none'\n    reason: 'no mechanical check'", "kind: 'check'\n    check: 'machine-only'")).compliance.kind, 'unregistered');
});
test('unregistered check is served and records a named non-applicable verdict', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(true).replace("kind: 'none'\n    reason: 'no mechanical check'", "kind: 'check'\n    check: 'machine-only'"));
  const result = await f.call({ tool: 'Agent' });
  assert.match(result.deny, /Follow this rule/);
  await f.call({ tool: 'Agent' });
  const verdicts = String(f.stored.get('compliance-verdicts-jsonl')).trim().split('\n').map(JSON.parse);
  assert.equal(verdicts[0].verdict, 'unregistered check');
  assert.equal(verdicts[0].reason, 'unregistered check machine-only');
});

test('registered check records first served act and subsequent governed retry', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'none'\n    reason: 'no mechanical check'", "kind: 'check'\n    check: 'agent-model'"));
  await f.call({ tool: 'Agent', input: { model: '' } });
  await f.call({ tool: 'Agent', input: { model: 'sonnet' } });
  const rows = String(f.stored.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.verdict), ['not followed', 'followed']);
  assert.equal(rows[0].ruleIdentity.includes('sample.md'), true);
});
test('one directory contract and home fallback', () => {
  assert.deepEqual(ruleDirectories('/project/', '/config/'), { project: '/project/.claude/rules-on-demand', user: '/config/rules-on-demand', projectStatic: '/project/.claude/rules', userStatic: '/config/rules' });
  assert.equal(configDirectory({ USERPROFILE: 'C:\\Users\\tester' }), 'C:\\Users\\tester/.claude');
  assert.equal(configDirectory({}), null);
});

test('overflow rotates verdict files in quality data without growing store keys', async () => {
  const f = fixture({ userNames: ['check.md'] });
  f.files.set('/sample-config/rules-on-demand/check.md', `---\non-demand:\n  triggers:\n    - kind: 'bash'\n      regex: 'git push'\n  compliance:\n    kind: 'bash-command'\n    window: '2'\n    on-close: 'not applicable'\n    act-regex: 'git push'\n    require-regex: 'origin'\n---\nCheck destination.\n`);
  f.stored.set('compliance-verdicts-jsonl', 'x'.repeat(3_500_000));
   const archives = new Map();
   f.$.fs.write = async (path, text) => archives.set(path, text);
   f.$.fs.remove = async (path) => archives.delete(path);
   const list = f.$.fs.list;
   f.$.fs.list = async (path) => path.endsWith('/quality') ? [...archives.keys()].filter((item) => item.startsWith(`${path}/`)).map((item) => ({ name: item.slice(path.length + 1), kind: 'file' })) : list(path);
  // Use the fixture's registered call adapter by changing only its tool fields.
  const result = await f.call({ tool: 'Bash', command: 'git push origin main' });
  assert.match(result.context[0], /Check destination/);
   assert.equal(archives.size, 1);
   assert.equal([...f.stored.keys()].filter((key) => key.startsWith('compliance-verdicts-archive-')).length, 0);
   for (let index = 0; index < 16; index++) {
     f.stored.set('compliance-verdicts-jsonl', 'x'.repeat(3_500_000));
     await f.call({ tool: 'Bash', command: 'git push origin main', agentId: `agent-${index}` });
   }
   assert.equal(archives.size, 14);
});

test('input-regex uses the flat host tool-call arguments and narrows a tool match', async () => {
  const f = fixture({ userNames: ['narrow.md'] });
  f.files.set('/sample-config/rules-on-demand/narrow.md', `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      input-regex: '"model":"sonnet"'\n  compliance:\n    kind: 'none'\n    reason: 'fixture'\n---\nChoose model.\n`);
  assert.deepEqual(await f.call({ model: 'haiku' }), {});
  assert.match((await f.call({ model: 'sonnet' })).context[0], /Choose model/);
});
test('input-regex missing input is reported and cannot select', async () => {
  const f = fixture({ userNames: ['narrow.md'] });
  f.files.set('/sample-config/rules-on-demand/narrow.md', `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      input-regex: 'isolation'\n  compliance:\n    kind: 'none'\n    reason: 'fixture'\n---\nOnly isolated.\n`);
  assert.deepEqual(await f.call({}), {});
  assert.match(f.logs.join('\n'), /narrow.md: input-regex trigger not fired, the Agent call carried no input/);
  assert.deepEqual(await f.call({ tool_use_id: 'synthetic', consent: 'yes' }), {});
  assert.match(f.logs.join('\n'), /narrow.md: input-regex/);
});

test('concurrent ride-along serves once after the first result', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false));
  let release;
  const held = new Promise((resolve) => { release = resolve; });
  let entered = 0;
  const next = async () => { entered++; await held; return {}; };
  const first = f.call({}, next);
  const second = f.call({}, next);
  while (entered < 2) await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  const results = await Promise.all([first, second]);
  assert.equal(results.filter((result) => result.context?.length).length, 1);
});

test('refusal explains unchanged retry and logs every serve', async () => {
  const f = fixture();
  assert.match((await f.call({})).deny, /retry the same call unchanged or corrected by the rule; this refusal happens once per rule per context/i);
  assert.match(f.logs.join('\n'), /serving sample.md/);
});

test('prompt delivery records its channel and governed act', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: 'false'", "kind: 'prompt'\n      regex: 'ready'"));
  const handlers = new Map();
  // The fixture exposes handlers through the registration performed by register.
  resetForSelftest();
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  await handlers.get('prompt.submit')(f.$, { text: 'ready', cwd: '/sample-project' }, async () => ({}));
  const ctx = f.stored.get('sessions')['sample-session'].contexts['0'];
  assert.equal(f.stored.get('served')['sample.md'].byChannel['prompt.submit'], 1);
  assert.equal(ctx.governedActs[0].rule, 'sample.md');
});

test('journal merges governed acts by identity', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false));
  await f.call({});
  await f.call({});
  const acts = f.stored.get('sessions')['sample-session'].contexts['0'].governedActs;
  assert.equal(acts.length, 1);
  assert.equal(acts[0].count, 2);
});

test('empty deny result stops delivery', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false));
  assert.deepEqual(await f.call({}, async () => ({ deny: '' })), { deny: '' });
});

test('model sees governed arguments while persisted verdict stores only a summary', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'none'\n    reason: 'no mechanical check'", "kind: 'model'\n    model: 'haiku'\n    prompt: 'Judge the call'\n    window: '1'\n    on-close: 'not applicable'"));
  let prompt = '';
  f.$.model = { classify: async (text) => { prompt = text; return 'followed'; } };
  await f.call({ tool: 'Agent', input: { prompt: 'private argument', file_path: '/path/to/example.ts' } });
  await new Promise((resolve) => setTimeout(resolve, 5));
  await f.call({ tool: 'Agent', input: { prompt: 'different private argument', file_path: '/path/to/next.ts' } });
  assert.match(prompt, /different private argument/);
  const record = JSON.parse(f.stored.get('compliance-verdicts-jsonl'));
  assert.doesNotMatch(JSON.stringify(record), /private argument/);
  assert.equal(record.trigger, 'tool.call:Agent');
  assert.notEqual(record.injectedAt, record.decidedAt);
});

test('turn closure records turn ended, not window closed', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'none'\n    reason: 'no mechanical check'", "kind: 'bash-command'\n    window: '2'\n    on-close: 'not applicable'\n    act-regex: 'git push'\n    require-regex: 'origin'"));
  await f.call({});
  const handlers = new Map();
  resetForSelftest();
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  await handlers.get('tool.call')(f.$, { tool: 'Agent', cwd: '/sample-project' }, async () => ({}));
  await handlers.get('turn.complete')(f.$, {}, async () => ({}));
  assert.equal(JSON.parse(f.stored.get('compliance-verdicts-jsonl')).reason, 'turn ended');
});

test('compaction closes pending verdict rather than losing it', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'none'\n    reason: 'no mechanical check'", "kind: 'bash-command'\n    window: '3'\n    on-close: 'not applicable'\n    act-regex: 'git push'\n    require-regex: 'origin'"));
  const handlers = new Map();
  resetForSelftest();
  register((name, handler) => handlers.set(name, handler), { enabled: true });
  await handlers.get('tool.call')(f.$, { tool: 'Agent', cwd: '/sample-project' }, async () => ({}));
  await handlers.get('session.compact')(f.$, {}, async () => ({}));
  assert.equal(JSON.parse(f.stored.get('compliance-verdicts-jsonl')).reason, 'compaction');
});

test('journal retries a size failure with fewer older sessions', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false));
  f.stored.set('sessions', Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`old-${i}`, { last: '2020-01-01T00:00:00.000Z', contexts: {} }])));
  const original = f.$.store.set;
  const originalGet = f.$.store.get;
  f.$.store.get = async (name) => name === 'sessions' ? structuredClone(await originalGet(name)) : originalGet(name);
  f.$.store.set = async (name, value) => {
    if (name === 'sessions' && Object.keys(value).length > 30) throw new Error('store size exceeded');
    return original(name, value);
  };
  await f.call({});
  assert.ok(f.stored.get('sessions')['sample-session']);
});
