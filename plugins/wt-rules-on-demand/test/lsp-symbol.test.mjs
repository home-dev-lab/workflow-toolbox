import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractSymbol, classifyGrep, servedExtensions, detectorEnvironment } from '../hooks/lsp-symbol.js';
import { parseRuntimeRule, register, resetForSelftest } from '../hooks/hooks.js';

const rule = (extra = '') => `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Grep$'\n      detector: 'lsp-symbol-grep'\n      before-first-act: true\n  compliance:\n    kind: 'next-call'\n    tool: '^(?:LSP|Grep)$'\n    require-tool: '^LSP$'\n    window: '3'\n    on-close: 'not applicable'\n---\nUse LSP.\n${extra}`;

// Exercise the core's request protocol without giving it a host handle.
async function fulfill(plan, host) {
  let step = plan.next();
  while (!step.done) {
    const { op, path, options } = step.value;
    let response;
    try {
      let value;
      if (op === 'read') value = await host.fs.read(path);
      else if (op === 'stat') value = await host.fs.stat(path, options);
      else if (op === 'list') value = await host.fs.list(path);
      else value = await host.env.get(path);
      response = { value };
    } catch (error) { response = { error }; }
    step = plan.next(response);
  }
  return step.value;
}

function fake(clock) {
  resetForSelftest();
  const hooks = new Map();
  register((name, fn) => hooks.set(name, fn), { enabled: true }, clock);
  const files = new Map([
    ['/cfg/rules-on-demand/lsp.md', rule()],
    ['/cfg/settings.json', JSON.stringify({ enabledPlugins: { 'ts@mk': true, 'java@mk': true } })],
    ['/cfg/plugins/installed_plugins.json', JSON.stringify({ plugins: {
      'ts@mk': [{ scope: 'user', installPath: '/ts' }],
      'java@mk': [{ scope: 'user', installPath: '/java' }],
    } })],
    ['/ts/.lsp.json', JSON.stringify({ ts: { command: 'ts-ls', extensionToLanguage: { '.ts': 'typescript' } } })],
    ['/java/.lsp.json', JSON.stringify({ java: { command: 'java-ls', extensionToLanguage: { '.java': 'java' } } })],
    ['/bin/ts-ls', ''], ['/bin/java-ls', ''],
    ['/cfg/lsp-hint-skip.json', '[".java"]'],
    ['/repo/tsconfig.json', '{}'],
  ]);
  const store = new Map();
  let reads = 0;
  const $ = {
    env: { get: async (name) => ({ CLAUDE_CONFIG_DIR: '/cfg', HOME: '/home/u', PATH: '/bin' })[name] },
    fs: {
      read: async (path) => { reads++; if (!files.has(path)) { throw new Error(`ENOENT: ${path}`); } return files.get(path); },
      stat: async (path) => ({ kind: files.has(path) || /\.[a-z]+$/i.test(path) ? 'file' : 'dir', size: files.get(path)?.length ?? 0, realPath: path }),
      list: async (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`) && !p.slice(dir.length + 1).includes('/')).map((p) => ({ name: p.slice(dir.length + 1), kind: 'file' })),
    },
    ui: { log: async () => {} }, session: { id: async () => 's', messages: async () => [] },
    store: { get: async (key) => store.get(key), set: async (key, value) => store.set(key, value) },
  };
  const call = (tool, input = {}, next = async () => ({})) => hooks.get('tool.call')($, { tool, input, cwd: '/repo' }, next);
  const rows = () => String(store.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);
  return { $, files, store, hooks, call, rows, reads: () => reads };
}

test('reference symbol forms and exclusions', () => {
  for (const value of ['buildEnvelope', '\\bSessionStore\\b', 'function parseConfig', 'export function parseConfig',
    'async function parseConfig', 'class SessionStore', 'interface RunReceipt', 'const resolveModel =',
    'const resolveModel\\s*=', 'def load_config', 'fun startServer', 'resolveModel\\(', 'resolveModel(',
    'load_config', 'function formatChannelBatch|export function formatChannelBatch',
    'class Broker|class SqliteStorage|new Broker|new SqliteStorage', 'new SessionStore'])
    assert.ok(extractSymbol(value), `expected symbol-shaped: ${value}`);
  for (const value of ['timeout', 'TODO', 'CLAUDE_CONFIG_DIR', 'error|warn', 'foo.*bar', 'Session',
    'hello world', '"buildEnvelope"', 'import .* from', '',
    'interface SpeakResult|type SpeakResult|status.*held',
    'classA|classB|classC|classD|classE', 'def test_'])
    assert.equal(extractSymbol(value), null, `expected NOT symbol-shaped: ${value}`);
});

test('classifier: file constraint, marker, Python snake and mute', async () => {
  const f = fake();
  const env = { configDir: '/cfg', cwd: '/repo', pathEnv: '/bin', home: '/home/u' };
  assert.deepEqual([...await fulfill(servedExtensions(env), f.$)].sort(), ['.ts']);
  assert.equal(await fulfill(classifyGrep({ pattern: 'buildEnvelope', path: '/repo/src/a.ts' }, env), f.$), true);
  assert.equal(await fulfill(classifyGrep({ pattern: 'buildEnvelope', path: '/repo/src/a.java', type: 'ts' }, env), f.$), false);
  assert.equal(await fulfill(classifyGrep({ pattern: 'load_config', path: '/repo/src/a.ts' }, env), f.$), false);
  assert.equal(await fulfill(classifyGrep({ pattern: 'buildEnvelope', path: '/repo' }, env), f.$), true);
  assert.equal(await fulfill(classifyGrep({ pattern: 'buildEnvelope', path: '/repo/src/a.groovy' }, env), f.$), false);
});

test('pure classifier returns before requesting I/O for non-symbol patterns', () => {
  assert.deepEqual(classifyGrep({ pattern: 'TODO', path: '/repo/a.ts' }, {}).next(), { value: false, done: true });
});

test('pure served-set plan propagates non-missing read failures through its response', async () => {
  const f = fake();
  f.$.fs.read = async () => { throw new Error('permission denied'); };
  await assert.rejects(() => fulfill(servedExtensions({ configDir: '/cfg', cwd: '/repo' }), f.$), /permission denied/);
});

test('parser rejects unknown or misplaced detector and incomplete next-call', () => {
  assert.equal(parseRuntimeRule('lsp.md', rule()).compliance.kind, 'next-call');
  assert.throws(() => parseRuntimeRule('lsp.md', rule().replace('lsp-symbol-grep', 'unknown')), /unknown detector/);
  assert.throws(() => parseRuntimeRule('lsp.md', rule().replace("kind: 'tool'", "kind: 'prompt'").replace("tool: '^Grep$'", "regex: 'Grep'")), /detector.*tool/);
  assert.throws(() => parseRuntimeRule('lsp.md', rule().replace("    require-tool: '^LSP$'\n", '')), /require-tool/);
});

test('symbol Grep refuses once; non-symbol and muted Greps do not read detector files', async () => {
  const f = fake();
  await f.call('Read'); // Load the rule; the read count below measures detector reads only.
  const start = f.reads();
  assert.deepEqual(await f.call('Grep', { pattern: 'TODO', path: '/repo/a.ts' }), {});
  assert.equal(f.reads(), start);
  assert.equal((await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.java' })).deny, undefined);
  assert.match((await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' })).deny, /Use LSP/);
  const scanned = f.reads();
  assert.deepEqual(await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' }), {});
  assert.equal(f.reads(), scanned);
});

test('next-call: first matching call start decides once, or window closes', async () => {
  for (const [sequence, expected] of [
    [['ToolSearch', 'LSP', 'Grep'], 'followed'],
    [['Grep', 'LSP'], 'not followed'],
    [['Read', 'Read', 'Read', 'LSP'], 'not applicable'],
  ]) {
    const f = fake();
    await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' });
    for (const name of sequence) await f.call(name, { pattern: 'TODO' });
    assert.deepEqual(f.rows().map((row) => row.verdict), [expected]);
  }
});

test('a denied LSP start counts as followed; parallel calls decide only once', async () => {
  const f = fake();
  await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' });
  await f.call('LSP', {}, async () => ({ deny: 'blocked' }));
  assert.deepEqual(f.rows().map((row) => row.verdict), ['followed']);
  await Promise.all([f.call('LSP'), f.call('Grep', { pattern: 'TODO' })]);
  assert.deepEqual(f.rows().map((row) => row.verdict), ['followed']);
});

test('an LSP refused by another rule decides next-call before its retry', async () => {
  const f = fake();
  f.files.set('/cfg/rules-on-demand/block-lsp.md', `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^LSP$'\n      unconditional: true\n      before-first-act: true\n  compliance:\n    kind: 'none'\n    reason: 'fixture'\n---\nRetry LSP.\n`);
  assert.match((await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' })).deny, /Use LSP/);
  assert.match((await f.call('LSP')).deny, /Retry LSP/);
  assert.deepEqual(f.rows().map((row) => row.verdict), ['followed']);
  await f.call('LSP');
  assert.deepEqual(f.rows().map((row) => row.verdict), ['followed']);
});

test('two next-call windows decide together before the first verdict write', async () => {
  const f = fake();
  f.files.set('/cfg/rules-on-demand/second.md', rule('Second rule.'));
  await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' });
  const held = pause(), entered = pause();
  const set = f.$.store.set;
  let writes = 0;
  f.$.store.set = async (key, value) => {
    if (key === 'compliance-verdicts-jsonl' && !writes++) { entered.release(); await held.promise; }
    return set(key, value);
  };
  const lsp = f.call('LSP');
  await entered.promise;
  const grep = f.call('Grep', { pattern: 'TODO' });
  held.release(); await Promise.all([lsp, grep]);
  assert.deepEqual(f.rows().map((row) => row.verdict).sort(), ['followed', 'followed']);
  assert.deepEqual(f.rows().map((row) => row.rule).sort(), ['lsp.md', 'second.md']);
});

test('window one is decided by a denied LSP start, not a later call', async () => {
  const f = fake();
  f.files.set('/cfg/rules-on-demand/lsp.md', rule().replace("window: '3'", "window: '1'"));
  await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' });
  const held = pause(), entered = pause();
  const denied = f.call('LSP', {}, async () => { entered.release(); await held.promise; return { deny: 'host' }; });
  await entered.promise;
  await f.call('Grep', { pattern: 'TODO' });
  held.release(); await denied;
  assert.deepEqual(f.rows().map((row) => row.verdict), ['followed']);
});

test('a refusal log failure cannot undo the call-start verdict', async () => {
  const f = fake();
  f.files.set('/cfg/rules-on-demand/lsp.md', rule().replace("window: '3'", "window: '1'"));
  f.files.set('/cfg/rules-on-demand/block-lsp.md', `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^LSP$'\n      unconditional: true\n      before-first-act: true\n---\nRetry LSP.\n`);
  await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' });
  f.$.ui.log = async (message) => { if (message.includes('before-act refusal')) throw new Error('log failed'); };
  await assert.rejects(f.call('LSP'), /log failed/);
  await f.call('Read');
  assert.deepEqual(f.rows().map((row) => row.verdict), ['followed']);
});

test('compaction during a held next-call verdict write does not add a second verdict', async () => {
  const f = fake();
  await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' });
  let release, entered;
  const held = new Promise((done) => { release = done; });
  const started = new Promise((done) => { entered = done; });
  const set = f.$.store.set;
  f.$.store.set = async (key, value) => { if (key === 'compliance-verdicts-jsonl') { entered(); await held; } return set(key, value); };
  const deciding = f.call('LSP');
  await started;
  await f.hooks.get('session.compact')(f.$, {}, async () => ({}));
  release(); await deciding;
  assert.deepEqual(f.rows().map((row) => row.verdict), ['followed']);
});

test('an LSP handler entry decides before an immediately started compaction', async () => {
  const f = fake();
  await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' });
  const call = f.call('LSP');
  const compact = f.hooks.get('session.compact')(f.$, {}, async () => ({}));
  await Promise.all([call, compact]);
  assert.deepEqual(f.rows().map((row) => row.verdict), ['followed']);
});

test('broken detector never refuses and journals a trigger error', async () => {
  const f = fake();
  f.$.fs.read = async (path) => { if (path === '/cfg/settings.json') { throw new Error('permission denied'); } return f.files.get(path); };
  assert.deepEqual(await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' }), {});
  const errors = f.store.get('sessions')?.s?.contexts?.['0']?.triggerErrors ?? [];
  assert.match(errors[0]?.error ?? '', /detector failed: permission denied/);
});

test('compaction refreshes the served set without closing a decided in-flight next-call', async () => {
  const f = fake();
  await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' });
  let release, entered;
  const held = new Promise((done) => { release = done; });
  const started = new Promise((done) => { entered = done; });
  const call = f.call('LSP', {}, async () => { entered(); await held; return {}; });
  await started;
  await f.hooks.get('session.compact')(f.$, {}, async () => ({}));
  release(); await call;
  assert.deepEqual(f.rows().map((row) => row.verdict), ['followed']);
  f.files.set('/cfg/lsp-hint-skip.json', '[".java", ".ts"]');
  assert.equal((await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' })).deny, undefined);
});

test('concurrent first symbol Greps share one availability scan', async () => {
  const f = fake();
  let scans = 0;
  const original = f.$.fs.read;
  f.$.fs.read = async (path) => { if (path === '/cfg/plugins/installed_plugins.json') { scans++; } return original(path); };
  const [a, b] = await Promise.all([
    f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' }),
    f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/b.ts' }),
  ]);
  assert.ok(a.deny && b.deny);
  assert.equal(scans, 1);
});

test('server resolution respects project false, project install precedence, and a canonical alias', async () => {
  const f = fake();
  const installed = { plugins: { 'ts@mk': [
    { scope: 'user', installPath: '/ts' },
    { scope: 'local', projectPath: '/project', installPath: '/local' },
  ] } };
  f.files.set('/cfg/plugins/installed_plugins.json', JSON.stringify(installed));
  f.files.set('/project/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'ts@mk': false } }));
  const stat = f.$.fs.stat;
  f.$.fs.stat = async (path, opts) => opts?.resolve && path === '/alias/src' ? { kind: 'dir', realPath: '/project/src' } : stat(path, opts);
  const env = { configDir: '/cfg', cwd: '/alias/src', pathEnv: '/bin' };
    assert.equal((await fulfill(servedExtensions(env), f.$)).has('.ts'), false);
  f.files.set('/project/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'ts@mk': true } }));
  f.files.set('/project/.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'ts@mk': true } }));
  f.files.set('/local/.lsp.json', JSON.stringify({ local: { command: 'ts-ls', extensionToLanguage: { '.tsx': 'typescriptreact' } } }));
  for (const installs of [installed.plugins['ts@mk'], [...installed.plugins['ts@mk']].reverse()]) {
    f.files.set('/cfg/plugins/installed_plugins.json', JSON.stringify({ plugins: { 'ts@mk': installs } }));
    assert.deepEqual([...await fulfill(servedExtensions(env), f.$)], ['.tsx']);
  }
});

test('Windows drive and UNC configs resolve PATHEXT and absolute backslash commands', async () => {
  for (const cfg of ['C:\\Users\\u\\.claude', '\\\\server\\share\\.claude']) {
    const f = fake();
    const root = cfg.replaceAll('\\', '/');
    f.files.set(`${root}/settings.json`, JSON.stringify({ enabledPlugins: { 'ts@mk': true } }));
    f.files.set(`${root}/plugins/installed_plugins.json`, JSON.stringify({ plugins: { 'ts@mk': [{ installPath: '/ts' }] } }));
    f.files.set('/ts/.lsp.json', JSON.stringify({ ts: { command: 'ts-ls', extensionToLanguage: { '.ts': 'typescript' } } }));
    f.files.set('C:/bin/ts-ls.CMD', '');
    const env = { configDir: cfg, cwd: '/repo', pathEnv: 'C:\\bin;C:\\missing', windows: true, pathExt: '.EXE;.CMD' };
    assert.equal((await fulfill(servedExtensions(env), f.$)).has('.ts'), true);
    f.files.set('/ts/.lsp.json', JSON.stringify({ ts: { command: 'C:\\bin\\ts-ls.CMD', extensionToLanguage: { '.ts': 'typescript' } } }));
    assert.equal((await fulfill(servedExtensions(env), f.$)).has('.ts'), true);
  }
});

test('an exhausted shared regex budget cannot select a negative or throwing detector', async () => {
  for (const fail of [false, true]) {
    let tick = 0;
    const f = fake(() => (tick += 250));
    f.files.delete('/cfg/rules-on-demand/lsp.md');
    f.files.set('/cfg/rules-on-demand/a.md', `---\non-demand:\n  triggers:\n${Array(12).fill("    - kind: 'tool'\n      tool: '^Grep$'\n      unconditional: true").join('\n')}\n  compliance:\n    kind: 'none'\n    reason: 'fixture'\n---\nBudget.\n`);
    f.files.set('/cfg/rules-on-demand/z.md', rule());
    if (fail) f.$.fs.read = async (path) => { if (path === '/cfg/settings.json') { throw new Error('unreadable'); } return f.files.get(path); };
    const result = await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.groovy', command: 'a'.repeat(16000) });
    assert.doesNotMatch(result.deny ?? result.context?.join('') ?? '', /Use LSP/);
    assert.ok(f.store.get('sessions')?.s?.contexts?.['0']?.triggerErrors?.some((row) => row.rule === 'z.md' && /budget|detector failed/.test(row.error)));
  }
});

test('unknown type cannot be rescued by an explicit served file extension', async () => {
  const f = fake();
  assert.equal(await fulfill(classifyGrep({ pattern: 'buildEnvelope', type: 'md', path: '/repo/a.ts' },
    { configDir: '/cfg', cwd: '/repo', pathEnv: '/bin' }), f.$), false);
});

test('missing config and home cannot invent a served profile', async () => {
  const f = fake();
  f.$.env.get = async (name) => name === 'PATH' ? '/bin' : undefined;
  await assert.rejects(() => fulfill(detectorEnvironment(
    { tool: 'Grep', cwd: '/repo', input: { pattern: 'buildEnvelope', path: '/repo/a.ts' } }), f.$), /config directory/);
});

test('a project settings false disables a user-only install at its cwd', async () => {
  const f = fake();
  f.files.set('/repo/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'ts@mk': false } }));
  assert.equal((await fulfill(servedExtensions({ configDir: '/cfg', cwd: '/repo/src', pathEnv: '/bin', home: '/home/u' }), f.$)).has('.ts'), false);
});

test('an unrelated child local settings file cannot hide an ancestor plugin disable', async () => {
  const f = fake();
  f.files.set('/repo/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'ts@mk': false } }));
  f.files.set('/repo/src/.claude/settings.local.json', JSON.stringify({ permissions: { allow: [] } }));
  const env = { configDir: '/cfg', cwd: '/repo/src', pathEnv: '/bin', home: '/home/u' };
  assert.deepEqual([...await fulfill(servedExtensions(env), f.$)], []);
  f.files.set('/repo/src/.claude/settings.local.json', JSON.stringify({ enabledPlugins: { 'ts@mk': true } }));
  assert.deepEqual([...await fulfill(servedExtensions(env), f.$)], []);
});

test('a confirmed missing explicit target cannot qualify by its suffix', async () => {
  const f = fake();
  const stat = f.$.fs.stat;
  f.$.fs.stat = async (path, options) => {
    if (path === '/repo/missing.ts') throw new Error(`wt-rules-on-demand: $.fs.stat(${path}) failed: ENOENT`);
    return stat(path, options);
  };
  const env = { configDir: '/cfg', cwd: '/repo', pathEnv: '/bin', home: '/home/u' };
  assert.equal(await fulfill(classifyGrep({ pattern: 'buildEnvelope', path: '/repo/missing.ts' }, env), f.$), false);
  assert.equal((await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/missing.ts' })).deny, undefined);
});

test('UNC marker walk stays inside its share', async () => {
  const f = fake();
  f.files.set('//server/tsconfig.json', '{}');
  assert.equal(await fulfill(classifyGrep({ pattern: 'buildEnvelope' },
    { configDir: '/cfg', cwd: '//server/share', pathEnv: '/bin', home: '/home/u' }), f.$), false);
});

const pause = () => { let release; const promise = new Promise((resolve) => { release = resolve; }); return { promise, release }; };

test('exhausted ordinary trigger cannot borrow detector refusal', async () => {
  let tick = 0;
  const f = fake(() => tick++ ? 3000 : 0);
  f.files.set('/cfg/rules-on-demand/lsp.md', `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Read$'\n      unconditional: true\n    - kind: 'tool'\n      tool: '^Grep$'\n      detector: 'lsp-symbol-grep'\n      before-first-act: true\n---\nUse LSP.\n`);
  assert.deepEqual(parseRuntimeRule('lsp.md', f.files.get('/cfg/rules-on-demand/lsp.md')).triggers.map((entry) => entry.beforeFirstAct), [false, true]);
  const result = await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.groovy' });
  assert.ok(tick >= 2, `clock advanced only ${tick}`);
  assert.ok(f.store.get('sessions')?.s?.contexts?.['0']?.triggerErrors?.some((row) => row.rule === 'lsp.md' && /budget exhausted/.test(row.error)), 'mixed rule not exhausted');
  assert.doesNotMatch(result.deny ?? '', /Use LSP/);
});

test('exhausted ordinary rule retains rule-wide ordinary refusal authority', async () => {
  let tick = 0;
  const f = fake(() => tick++ ? 3000 : 0);
  f.files.set('/cfg/rules-on-demand/lsp.md', `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Read$'\n      unconditional: true\n    - kind: 'tool'\n      tool: '^Bash$'\n      unconditional: true\n      before-first-act: true\n---\nOrdinary refusal.\n`);
  assert.match((await f.call('Grep')).deny ?? '', /Ordinary refusal/);
});

test('pre-evaluation exhaustion cannot borrow a detector that returned false', async () => {
  let tick = 0;
  const f = fake(() => tick++ ? 3000 : 0);
  f.files.set('/cfg/rules-on-demand/a.md', `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Read$'\n      unconditional: true\n---\nEarlier.\n`);
  f.files.set('/cfg/rules-on-demand/lsp.md', `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Read$'\n      unconditional: true\n    - kind: 'tool'\n      tool: '^Grep$'\n      detector: 'lsp-symbol-grep'\n      before-first-act: true\n---\nUse LSP.\n`);
  const result = await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.groovy' });
  assert.doesNotMatch(result.deny ?? '', /Use LSP/);
});

test('detector I/O does not spend the regex deadline of later ordinary rules', async () => {
  let tick = 0;
  const f = fake(() => tick);
  f.files.set('/cfg/rules-on-demand/z.md', `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Bash$'\n      unconditional: true\n      before-first-act: true\n---\nUnrelated refusal.\n`);
  const read = f.$.fs.read;
  f.$.fs.read = async (path) => { if (path === '/cfg/settings.json') { tick += 3000; } return read(path); };
  const result = await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.groovy' });
  assert.equal(tick, 3000);
  assert.doesNotMatch(result.deny ?? '', /Unrelated refusal/);
});

test('held legacy model evaluation cannot restore a decided next-call window', async () => {
  const f = fake();
  f.files.set('/cfg/rules-on-demand/model.md', `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Grep$'\n      unconditional: true\n      before-first-act: true\n  compliance:\n    kind: 'model'\n    model: 'test'\n    prompt: 'Check'\n    window: '1'\n    on-close: 'not applicable'\n---\nModel.\n`);
  const held = pause(), entered = pause();
  let classified = 0;
  f.$.model = { classify: async () => { if (!classified++) { entered.release(); await held.promise; } return 'followed'; } };
  await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' });
  assert.ok(f.store.get('sessions')?.s?.contexts?.['0']?.served?.['model.md'], 'model rule not served');
  const read = f.call('Read');
  await entered.promise;
  await f.call('LSP');
  held.release(); await read;
  await f.call('Grep', { pattern: 'TODO' });
  assert.deepEqual(f.rows().filter((row) => row.rule === 'lsp.md').map((row) => row.verdict), ['followed']);
});

test('turn end and compaction detach an open window before verdict I/O', async () => {
  const f = fake();
  await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' });
  const nextHeld = pause(), entered = pause(), writeHeld = pause(), writing = pause();
  const set = f.$.store.set;
  f.$.store.set = async (key, value) => { if (key === 'compliance-verdicts-jsonl') { writing.release(); await writeHeld.promise; } return set(key, value); };
  const candidate = f.call('Read', {}, async () => { entered.release(); await nextHeld.promise; return {}; });
  await entered.promise;
  const turn = f.hooks.get('turn.complete')(f.$, {}, async () => ({}));
  await writing.promise;
  const compact = f.hooks.get('session.compact')(f.$, {}, async () => ({}));
  nextHeld.release(); writeHeld.release();
  await Promise.all([turn, compact, candidate]);
  assert.deepEqual(f.rows().filter((row) => row.rule === 'lsp.md').map((row) => row.verdict), ['not applicable']);
});

test('a denied in-flight LSP decides before a parallel Grep starts', async () => {
  const f = fake();
  await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' });
  const held = pause(), entered = pause();
  const denied = f.call('LSP', {}, async () => { entered.release(); await held.promise; return { deny: 'host' }; });
  await entered.promise;
  await f.call('Grep', { pattern: 'TODO' });
  held.release(); await denied;
  await f.call('LSP');
  assert.deepEqual(f.rows().map((row) => row.verdict), ['followed']);
});

test('LSP declarations replace by name, accept arrays and ignore marketplace fields with a manifest', async () => {
  const f = fake();
  const env = { configDir: '/cfg', cwd: '/repo', home: '/home/u', pathEnv: '/bin' };
  f.files.delete('/cfg/lsp-hint-skip.json');
  f.files.set('/cfg/settings.json', JSON.stringify({ enabledPlugins: { 'ts@mk': true } }));
  f.files.set('/ts/.claude-plugin/plugin.json', JSON.stringify({ lspServers: [{ ts: { command: 'java-ls', extensionToLanguage: { '.java': 'java' } } }] }));
  assert.deepEqual([...await fulfill(servedExtensions(env), f.$)].sort(), ['.java']);
  f.files.set('/ts/override.json', JSON.stringify({ ts: { command: 'ts-ls', extensionToLanguage: { '.tsx': 'typescriptreact' } } }));
  f.files.set('/ts/.claude-plugin/plugin.json', JSON.stringify({ lspServers: [{ ts: { command: 'java-ls', extensionToLanguage: { '.java': 'java' } } }, 'override.json'] }));
  assert.deepEqual([...await fulfill(servedExtensions(env), f.$)], ['.tsx']);
  f.files.set('/ts/.claude-plugin/plugin.json', '{}');
  f.files.set('/cfg/plugins/marketplaces/mk/.claude-plugin/marketplace.json', JSON.stringify({ plugins: [{ name: 'ts', lspServers: { other: { command: 'java-ls', extensionToLanguage: { '.groovy': 'groovy' } } } }] }));
  assert.equal((await fulfill(servedExtensions(env), f.$)).has('.groovy'), false);
  f.files.delete('/ts/.claude-plugin/plugin.json');
  assert.equal((await fulfill(servedExtensions(env), f.$)).has('.groovy'), true);
});

test('target type, glob and file constraints intersect; unknown glob never uses markers', async () => {
  const f = fake();
  const env = { configDir: '/cfg', cwd: '/repo', home: '/home/u', pathEnv: '/bin' };
  assert.equal(await fulfill(classifyGrep({ pattern: 'buildEnvelope', type: 'ts', glob: '*.md', path: '/repo' }, env), f.$), false);
  assert.equal(await fulfill(classifyGrep({ pattern: 'buildEnvelope', glob: 'README*', path: '/repo' }, env), f.$), false);
  assert.equal(await fulfill(classifyGrep({ pattern: 'buildEnvelope', glob: '*.ts,README*', path: '/repo' }, env), f.$), false);
  for (const glob of ['!*.ts', '!**/*.ts'])
    assert.equal(await fulfill(classifyGrep({ pattern: 'buildEnvelope', type: 'ts', glob, path: '/repo' }, env), f.$), false, glob);
});

test('cwd-less relative target resolves through host real cwd; relative PATH entries are skipped', async () => {
  const f = fake();
  f.files.set('/repo/src/tsconfig.json', '{}');
  const stat = f.$.fs.stat;
  f.$.fs.stat = async (path, options) => path === '.' && options?.resolve ? { kind: 'dir', realPath: '/repo' } : stat(path, options);
  const prepared = await fulfill(detectorEnvironment({ tool: 'Grep', input: { pattern: 'buildEnvelope', path: 'src' } }), f.$);
  assert.equal(await fulfill(classifyGrep({ pattern: 'buildEnvelope', path: 'src' }, prepared.env), f.$), true);
  f.files.delete('/bin/ts-ls');
  f.files.set('bin/ts-ls', '');
  assert.equal((await fulfill(servedExtensions({ configDir: '/cfg', cwd: '/repo', pathEnv: 'bin' }), f.$)).has('.ts'), false);
  f.files.set('ts-ls', '');
  assert.equal((await fulfill(servedExtensions({ configDir: '/cfg', cwd: '/repo', pathEnv: '' }), f.$)).has('.ts'), false);
});

test('handler served-set cache follows cwd, config and environment inputs', async () => {
  const f = fake();
  f.files.set('/off/.claude/settings.json', JSON.stringify({ enabledPlugins: { 'ts@mk': false } }));
  const callAt = (cwd, path) => f.hooks.get('tool.call')(f.$,
    { tool: 'Grep', cwd, input: { pattern: 'buildEnvelope', path } }, async () => ({}));
  let scans = 0;
  const read = f.$.fs.read;
  f.$.fs.read = async (path) => { if (path.endsWith('plugins/installed_plugins.json')) { scans++; } return read(path); };
  assert.equal((await callAt('/repo', '/repo/a.groovy')).deny, undefined);
  assert.equal((await callAt('/off', '/off/a.ts')).deny, undefined);
  assert.match((await callAt('/repo', '/repo/a.ts')).deny, /Use LSP/);
  assert.equal(scans, 3);
  // The rule is served now; subsequent Greps bypass the detector altogether.
  await Promise.all([callAt('/repo', '/repo/a.ts'), callAt('/repo', '/repo/b.ts')]);
  assert.equal(scans, 3);

  const other = fake();
  let changedScans = 0;
  const otherRead = other.$.fs.read;
  other.$.fs.read = async (path) => { if (path.endsWith('plugins/installed_plugins.json')) { changedScans++; } return otherRead(path); };
  const otherCall = () => other.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' });
  const env = f.$.env.get;
  other.$.env.get = async (key) => key === 'PATH' ? '/missing' : env(key);
  assert.equal((await otherCall()).deny, undefined);
  other.$.env.get = async (key) => key === 'CLAUDE_CONFIG_DIR' ? '/different' : env(key);
  assert.equal((await otherCall()).deny, undefined);
  assert.equal(changedScans, 2);
});

test('rejected served-set scan is cleared for the next call', async () => {
  const f = fake();
  let failed = false;
  const read = f.$.fs.read;
  f.$.fs.read = async (path) => { if (path === '/cfg/settings.json' && !failed) { failed = true; throw new Error('EIO'); } return read(path); };
  assert.deepEqual(await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' }), {});
  assert.match((await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' })).deny ?? '', /Use LSP/);
});

test('a missing file reported in the real host error shape reads as absent, not as a detector failure', async () => {
  // Claude Code 2.1.284 rejects a missing file with this message (observed in the real-host e2e run).
  const f = fake();
  f.$.fs.read = async (path) => {
    if (!f.files.has(path)) { throw new Error(`wt-rules-on-demand: $.fs.read(${path}) failed: ENOENT`); }
    return f.files.get(path);
  };
  const result = await f.call('Grep', { pattern: 'buildEnvelope', path: '/repo/a.ts' });
  assert.match(result.deny ?? '', /Use LSP/);
  assert.ok(!(f.store.get('sessions')?.s?.contexts?.['0']?.triggerErrors ?? []).some((row) => /detector failed/.test(row.error)));
});
