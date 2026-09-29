import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, resetForSelftest, parseRuntimeRule } from '../hooks/hooks.js';
import { ruleDirectories, configDirectory } from '../paths.js';

const rule = (before = false) => `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: '${before}'\n  compliance:\n    kind: 'none'\n    reason: 'no mechanical check'\n---\nFollow this rule.\n`;
function fixture({ options = { enabled: true }, staticNames = [], userNames = ['sample.md'], projectNames = [], clock } = {}) {
  resetForSelftest();
  const handlers = new Map();
  register((event, handler) => handlers.set(event, handler), options, clock);
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
  while (delivered.length < 1) await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await Promise.all([one, two]);
  assert.deepEqual(delivered.map((context) => context.length).sort(), [0, 1]);
  assert.equal(f.stored.get('served')['sample.md'].count, 1);
});

test('competing prompt waits for rejected reservation, but does not double-serve accepted reservation', async () => {
  for (const firstOutcome of [{ deny: 'blocked' }, {}]) {
    const f = fixture();
    f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: 'false'", "kind: 'prompt'\n      regex: 'ready'"));
    let release, entered;
    const waiting = new Promise((resolve) => { release = resolve; });
    const started = new Promise((resolve) => { entered = resolve; });
    const handler = f.handlers.get('prompt.submit');
    const contexts = [];
    const first = handler(f.$, { text: 'ready', cwd: '/sample-project' }, async (input) => { contexts.push(input.context ?? []); entered(); await waiting; return firstOutcome; });
    await started;
    const second = handler(f.$, { text: 'ready', cwd: '/sample-project' }, async (input) => { contexts.push(input.context ?? []); return {}; });
    await new Promise((resolve) => setTimeout(resolve, 0));
    assert.equal(contexts.length, 1);
    release(); await Promise.all([first, second]);
    assert.deepEqual(contexts.map((item) => item.length), 'deny' in firstOutcome ? [1, 1] : [1, 0]);
    assert.equal(f.stored.get('served')['sample.md'].count, 1);
  }
});

test('competing prompt reselects after first host callback throws', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: 'false'", "kind: 'prompt'\n      regex: 'ready'"));
  const handler = f.handlers.get('prompt.submit');
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const first = handler(f.$, { text: 'ready', cwd: '/sample-project' }, async () => { entered(); await waiting; throw new Error('host failed'); });
  await started;
  let received;
  const second = handler(f.$, { text: 'ready', cwd: '/sample-project' }, async (event) => { received = event.context; return {}; });
  release();
  await assert.rejects(first, /host failed/);
  await second;
  assert.equal(received.length, 1);
  assert.equal(f.stored.get('served')['sample.md'].count, 1);
});

test('compaction during a prompt wait claims exactly the context delivered', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: 'false'", "kind: 'prompt'\n      regex: 'ready'"));
  const handler = f.handlers.get('prompt.submit');
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const deliveries = [];
  const submit = (next) => handler(f.$, { text: 'ready', cwd: '/sample-project' }, next);
  const a = submit(async (event) => { deliveries.push(event.context?.length ?? 0); entered(); await waiting; return {}; });
  await started;
  const b = submit(async (event) => { deliveries.push(event.context?.length ?? 0); return {}; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  await f.handlers.get('session.compact')(f.$, {}, async () => ({}));
  release(); await a; await b;
  await submit(async (event) => { deliveries.push(event.context?.length ?? 0); return {}; });
  assert.deepEqual(deliveries, [1, 0, 0]);
  assert.equal(f.stored.get('served')['sample.md'].count, deliveries.filter(Boolean).length);
});

test('compaction preserves an in-flight prompt reservation for a new waiter', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: 'false'", "kind: 'prompt'\n      regex: 'ready'"));
  const handler = f.handlers.get('prompt.submit');
  let release, entered;
  const waiting = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const delivered = [];
  const submit = (next) => handler(f.$, { text: 'ready', cwd: '/sample-project' }, next);
  const a = submit(async (event) => { delivered.push(event.context?.length ?? 0); entered(); await waiting; return {}; });
  await started;
  await f.handlers.get('session.compact')(f.$, {}, async () => ({}));
  const b = submit(async (event) => { delivered.push(event.context?.length ?? 0); return {}; });
  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(delivered, [1]);
  release(); await Promise.all([a, b]);
  assert.deepEqual(delivered, [1, 0]);
  assert.equal(f.stored.get('served')['sample.md'].count, 1);
});

test('failed skip diagnostic cannot prevent a valid neighbor rule loading', async () => {
  const f = fixture({ userNames: ['broken.md', 'sample.md'] });
  f.files.set('/sample-config/rules-on-demand/broken.md', 'not frontmatter');
  const log = f.$.ui.log;
  f.$.ui.log = async (message) => {
    if (message.includes('skipped')) throw new Error('logging unavailable');
    return log(message);
  };
  const result = await f.call({ tool: 'Agent' });
  assert.match(result.deny, /sample\.md/);
});

test('full context map closes pending verdicts on eviction', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'none'\n    reason: 'no mechanical check'", "kind: 'bash-command'\n    window: '100'\n    on-close: 'not applicable'\n    act-regex: 'git push'\n    require-regex: 'origin'"));
  for (let i = 0; i < 66; i++) await f.call({ agentId: `agent-${i}` });
  const rows = String(f.stored.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.equal(rows[0]?.reason, 'context evicted');
  assert.equal(rows[0]?.agentId, 'agent-0');
});

test('concurrent first calls of a new agent during an eviction share one context and every served window gets a verdict', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', rule(false).replace("kind: 'none'\n    reason: 'no mechanical check'", "kind: 'bash-command'\n    window: '100'\n    on-close: 'not applicable'\n    act-regex: 'git push'\n    require-regex: 'origin'"));
  for (let i = 0; i < 64; i++) await f.call({ agentId: `agent-${i}` });
  // Hold the first verdict write, which is the evicted context's window closing.
  const get = f.$.store.get;
  let held = false, release;
  const gate = new Promise((resolve) => { release = resolve; });
  f.$.store.get = async (name) => {
    if (name === 'compliance-verdicts-jsonl' && !held) { held = true; await gate; }
    return get(name);
  };
  const one = f.call({ agentId: 'agent-new' });
  while (!held) await new Promise((resolve) => setTimeout(resolve, 0));
  const two = f.call({ agentId: 'agent-new' });
  for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0));
  release();
  await Promise.all([one, two]);
  await f.handlers.get('turn.complete')(f.$, { agentId: 'agent-new' }, async () => ({}));
  const rows = String(f.stored.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);
  const served = f.stored.get('sessions')['sample-session'].contexts['agent:agent-new'].served['sample.md'];
  assert.equal(served, 1, 'one context for the new agent serves the rule once');
  assert.equal(rows.filter((row) => row.agentId === 'agent-new').length, served, 'every window served to the new agent is judged');
  assert.equal(rows.filter((row) => row.agentId === 'agent-0' && row.reason === 'context evicted').length, 1, 'the victim window is closed once');
});

// Each windowed kind, with a call its window judges and a call that leaves its window open.
const windowed = {
  'bash-command': { compliance: "kind: 'bash-command'\n    window: '100'\n    on-close: 'not applicable'\n    act-regex: 'git push'\n    require-regex: 'origin'", judged: { tool: 'Bash', command: 'git push origin' } },
  'tool-input': { compliance: "kind: 'tool-input'\n    tool: '^Write$'\n    require-input-regex: 'approved'\n    window: '100'\n    on-close: 'not applicable'", judged: { tool: 'Write', input: { file_path: 'notes.txt', content: 'approved' } } },
  'test-before-edit': { compliance: "kind: 'test-before-edit'\n    window: '100'\n    on-close: 'not applicable'\n    test-regex: 'npm test'\n    path-regex: 'sample\\.js'", judged: { tool: 'Edit', file_path: 'sample.js' } },
  model: { compliance: "kind: 'model'\n    model: 'haiku'\n    prompt: 'Judge the call'\n    window: '1'\n    on-close: 'not applicable'", judged: { tool: 'Read', file_path: 'notes.txt' } },
};
// A function replacement: a compliance holding `$'` (a regex ending in `$`) must not expand as a pattern.
const windowedRule = (compliance) => rule(false).replace("kind: 'none'\n    reason: 'no mechanical check'", () => compliance);
const verdictRows = (f) => String(f.stored.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);
// Hold the next verdict write until released; resolves `held` once a write is waiting.
function holdNextVerdict(f) {
  const get = f.$.store.get;
  let release, reached;
  const gate = new Promise((resolve) => { release = resolve; });
  const held = new Promise((resolve) => { reached = resolve; });
  let armed = true;
  f.$.store.get = async (name) => {
    if (name === 'compliance-verdicts-jsonl' && armed) { armed = false; reached(); await gate; }
    return get(name);
  };
  return { held, release };
}
const settle = async () => { for (let i = 0; i < 20; i++) await new Promise((resolve) => setTimeout(resolve, 0)); };

for (const [kind, { compliance, judged }] of Object.entries(windowed)) {
  test(`two concurrent calls judge one ${kind} window once`, async () => {
    const f = fixture();
    f.files.set('/sample-config/rules-on-demand/sample.md', windowedRule(compliance));
    f.$.model = { classify: async () => 'followed' };
    await f.call({ tool: 'Agent' });
    const { held, release } = holdNextVerdict(f);
    const one = f.call(judged);
    await held;
    const two = f.call(judged);
    await settle();
    release();
    await Promise.all([one, two]);
    await f.handlers.get('turn.complete')(f.$, {}, async () => ({}));
    const window = verdictRows(f).filter((row) => row.rule === 'sample.md' && row.trigger === 'tool.call:Agent');
    assert.equal(window.length, 1, `${kind}: ${JSON.stringify(window)}`);
  });

  test(`compaction during a held verdict write leaves an open ${kind} window closed`, async () => {
    // The open window is listed first so the held call has already kept it when compaction runs.
    const f = fixture({ userNames: ['open.md', 'push.md'] });
    f.files.set('/sample-config/rules-on-demand/push.md', windowedRule(windowed['bash-command'].compliance));
    // The open window must survive the Bash call: a model window is widened for that.
    f.files.set('/sample-config/rules-on-demand/open.md', windowedRule(kind === 'bash-command'
      ? compliance.replace("act-regex: 'git push'", "act-regex: 'npm publish'") : compliance.replace("window: '1'", "window: '5'")));
    f.$.model = { classify: async () => 'followed' };
    await f.call({ tool: 'Agent' });
    const { held, release } = holdNextVerdict(f);
    const call = f.call({ tool: 'Bash', command: 'git push origin' });
    await held;
    // Compaction closes its windows through the same write queue, so it completes only after the release.
    const compaction = f.handlers.get('session.compact')(f.$, {}, async () => ({}));
    await settle();
    release();
    await Promise.all([call, compaction]);
    await f.handlers.get('turn.complete')(f.$, {}, async () => ({}));
    const rows = verdictRows(f).filter((row) => row.trigger === 'tool.call:Agent');
    const count = (name) => rows.filter((row) => row.rule === name).length;
    assert.deepEqual({ push: count('push.md'), open: count('open.md') }, { push: 1, open: 1 }, JSON.stringify(rows));
  });
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

const overBudget = '(?:[a]{1024}){4}b';
const longMiss = 'a'.repeat(16000);
const triggerRule = (lines, before = false) => `---\non-demand:\n  triggers:\n${lines}\n      before-first-act: '${before}'\n  compliance:\n    kind: 'none'\n    reason: 'fixture'\n---\nBudget rule body.\n`;
const errorsFor = (f) => f.stored.get('sessions')?.['sample-session']?.contexts?.['0']?.triggerErrors ?? [];

test('over-budget Bash trigger serves a refusal and records rule, source and command length', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', triggerRule(`    - kind: 'bash'\n      regex: '${overBudget}'`, true));
  const result = await f.call({ tool: 'Bash', command: longMiss });
  assert.match(result.deny, /Budget rule body/);
  assert.ok(errorsFor(f).some((row) => row.rule === 'sample.md' && row.pattern === overBudget && row.length === 16000));
});

test('over-budget prompt trigger injects the rule and journals its subject length', async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', triggerRule(`    - kind: 'prompt'\n      regex: '${overBudget}'`));
  let delivered;
  await f.handlers.get('prompt.submit')(f.$, { text: longMiss, cwd: '/sample-project' }, async (event) => {
    delivered = event.context; return {};
  });
  assert.match(delivered[0], /Budget rule body/);
  assert.ok(errorsFor(f).some((row) => row.rule === 'sample.md' && row.pattern === overBudget && row.length === 16000));
});

for (const [name, lines, event, pattern, length] of [
  ['command-head', `    - kind: 'bash'\n      command-head: 'true'\n      regex: '${overBudget}'`, { tool: 'Bash', command: longMiss }, overBudget, 16001],
  ['tool selector and no-input notice', `    - kind: 'tool'\n      tool: '${overBudget}'\n      input-regex: 'missing'`, { tool: longMiss }, overBudget, 16000],
  ['tool input', `    - kind: 'tool'\n      tool: '^Agent$'\n      input-regex: '${overBudget}'`, { tool: 'Agent', input: { content: longMiss } }, overBudget, 16014],
  ['path', `    - kind: 'path'\n      tool: '^Write$'\n      regex: '${overBudget}'`, { tool: 'Write', path: longMiss }, overBudget, 16000],
  ['path tool selector', `    - kind: 'path'\n      tool: '${overBudget}'\n      regex: 'never'`, { tool: longMiss, path: 'unmatched' }, overBudget, 16000],
]) test(`over-budget ${name} trigger serves and journals the failure`, async () => {
  const f = fixture();
  f.files.set('/sample-config/rules-on-demand/sample.md', triggerRule(lines));
  const result = await f.call(event);
  assert.match(result.context?.[0], /Budget rule body/);
  assert.ok(errorsFor(f).some((row) => row.rule === 'sample.md' && row.pattern === pattern && row.length === length), JSON.stringify(errorsFor(f)));
  if (name === 'tool selector and no-input notice') assert.doesNotMatch(f.logs.join('\n'), /input-regex trigger not fired/);
});

const budgetNotice = /shared regex budget exhausted: (\d+) rules served unevaluated/gi;
function crowdedFixture() {
  let time = 0;
  const names = Array.from({ length: 12 }, (_, index) => `budget-${index}.md`);
  const f = fixture({ userNames: names, clock: () => (time += 250) });
  for (const name of names) f.files.set(`/sample-config/rules-on-demand/${name}`, triggerRule(`    - kind: 'bash'\n      regex: '${overBudget}'`, true));
  return { f, names, elapsed: () => time };
}

test('one hook call exhausts a shared clock budget and serves and journals all unevaluated rules', async (t) => {
  const { f, names, elapsed } = crowdedFixture();
  const result = await f.call({ tool: 'Bash', command: longMiss });
  t.diagnostic(JSON.stringify({ case: 'shared-exhaustion', clockMs: elapsed(), records: errorsFor(f).length }));
  assert.ok(elapsed() <= 2500, `shared clock consumed ${elapsed()} ms`);
  for (const name of names) {
    assert.match(result.deny, new RegExp(name));
    assert.ok(errorsFor(f).some((row) => row.rule === name && row.pattern === overBudget && row.length === 16000 && /shared.*budget/i.test(row.error)), `${name} lacks shared-budget journal`);
  }
  assert.deepEqual(f.logs.flatMap((line) => [...line.matchAll(budgetNotice)].map((match) => Number(match[1]))), [names.length]);
});

test('crowded real-clock call has one shared step ceiling and publishes raw timing', async (t) => {
  const names = Array.from({ length: 12 }, (_, index) => `real-${index}.md`);
  const f = fixture({ userNames: names });
  for (const name of names) f.files.set(`/sample-config/rules-on-demand/${name}`, triggerRule(`    - kind: 'bash'\n      regex: '${overBudget}'`, true));
  const started = performance.now(), cpuStarted = process.cpuUsage();
  await f.call({ tool: 'Bash', command: longMiss });
  const cpu = process.cpuUsage(cpuStarted);
  const count = new Set(errorsFor(f).filter((row) => /shared.*budget/i.test(row.error)).map((row) => row.rule)).size;
  t.diagnostic(JSON.stringify({ case: 'real-clock-shared-exhaustion', ms: performance.now() - started,
    cpuMs: (cpu.user + cpu.system) / 1000, servedUnevaluated: count, journalRows: errorsFor(f).length }));
  assert.ok(count > 0, 'shared limit must exhaust before all patterns reach their private limit');
  assert.deepEqual(f.logs.flatMap((line) => [...line.matchAll(budgetNotice)].map((match) => Number(match[1]))), [count]);
});

test('prompt hook also shares its clock budget and reports the unevaluated count once', async () => {
  let time = 0;
  const names = Array.from({ length: 10 }, (_, index) => `prompt-${index}.md`);
  const f = fixture({ userNames: names, clock: () => (time += 250) });
  for (const name of names) f.files.set(`/sample-config/rules-on-demand/${name}`, triggerRule(`    - kind: 'prompt'\n      regex: '${overBudget}'`));
  let delivered;
  await f.handlers.get('prompt.submit')(f.$, { text: longMiss, cwd: '/sample-project' }, async (event) => { delivered = event.context; return {}; });
  assert.equal(delivered.length, names.length);
  assert.deepEqual(f.logs.flatMap((line) => [...line.matchAll(budgetNotice)].map((match) => Number(match[1]))), [names.length]);
  assert.equal(new Set(errorsFor(f).filter((row) => /shared.*budget/i.test(row.error)).map((row) => row.rule)).size, names.length);
});

test('one mass serve retains every current-call journal record even above the history cap', async () => {
  let time = 0;
  const names = Array.from({ length: 110 }, (_, index) => `many-${index}.md`);
  const f = fixture({ userNames: names, clock: () => (time += 250) });
  for (const name of names) f.files.set(`/sample-config/rules-on-demand/${name}`, triggerRule(`    - kind: 'prompt'\n      regex: '${overBudget}'`));
  await f.handlers.get('prompt.submit')(f.$, { text: longMiss, cwd: '/sample-project' }, async () => ({}));
  assert.equal(new Set(errorsFor(f).map((row) => row.rule)).size, names.length, 'one mass serve must journal every rule');
  assert.deepEqual(f.logs.flatMap((line) => [...line.matchAll(budgetNotice)].map((match) => Number(match[1]))), [names.length]);
});

test('a long literal-headed alternation matches normally without an exhaustion notice', async () => {
  const f = fixture();
  const heads = Array.from({ length: 30 }, (_, i) => `\\bcommand${String(i).padStart(2, '0')}\\s+--option\\b[^\\n]*--since`);
  const pattern = `(?:\\bgit\\s+log\\b[^\\n]*--since|PIPESTATUS|\\bgrep\\s+-[a-zA-Z]*c\\b|${heads.join('|')})`;
  f.files.set('/sample-config/rules-on-demand/sample.md', triggerRule(`    - kind: 'bash'\n      regex: '${pattern}'`));
  const result = await f.call({ tool: 'Bash', command: 'A=1 x; '.repeat(2341).slice(0, 16384) });
  assert.equal(result.deny, undefined);
  assert.equal(result.context, undefined);
  assert.doesNotMatch(f.logs.join('\n'), budgetNotice);
  assert.deepEqual(errorsFor(f), []);
});
