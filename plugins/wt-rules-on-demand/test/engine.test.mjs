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
  return { call, $, logs, stored, files };
}

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
test('one directory contract and home fallback', () => {
  assert.deepEqual(ruleDirectories('/project/', '/config/'), { project: '/project/.claude/rules-on-demand', user: '/config/rules-on-demand', projectStatic: '/project/.claude/rules', userStatic: '/config/rules' });
  assert.equal(configDirectory({ USERPROFILE: 'C:\\Users\\tester' }), 'C:\\Users\\tester/.claude');
  assert.equal(configDirectory({}), null);
});

test('overflow rotates verdict inside store without writing the project', async () => {
  const f = fixture({ userNames: ['check.md'] });
  f.files.set('/sample-config/rules-on-demand/check.md', `---\non-demand:\n  triggers:\n    - kind: 'bash'\n      regex: 'git push'\n  compliance:\n    kind: 'bash-command'\n    window: '2'\n    on-close: 'not applicable'\n    act-regex: 'git push'\n    require-regex: 'origin'\n---\nCheck destination.\n`);
  f.stored.set('compliance-verdicts-jsonl', 'x'.repeat(3_500_000));
  let writes = 0;
  f.$.fs.write = async () => { writes++; };
  // Use the fixture's registered call adapter by changing only its tool fields.
  const result = await f.call({ tool: 'Bash', command: 'git push origin main' });
  assert.match(result.context[0], /Check destination/);
  assert.equal(writes, 0);
  assert.ok([...f.stored.keys()].some((key) => key.startsWith('compliance-verdicts-archive-')));
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
