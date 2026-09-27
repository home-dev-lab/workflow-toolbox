import { test } from 'node:test';
import assert from 'node:assert/strict';
import { register, resetForSelftest, parseRuntimeRule } from '../hooks/hooks.js';
import { normalize, resolveContext } from '../scripts/transcript-verdicts.mjs';
import { qualityDataDir, readSpec } from '../scripts/rule-lifecycle-lib.mjs';
import { mkdtemp, mkdir, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv } from './clean-env.mjs';
import { killWorker } from '../scripts/kill-worker.mjs';
import { launchQuality } from '../scripts/launch-quality.mjs';
import { EventEmitter } from 'node:events';
import { argumentEvidence, SUBJECT_CAP } from '../hooks/evidence.js';
import { triggerMatches } from '../hooks/trigger-match.js';

const text = (before = true, compliance = "kind: 'none'\n    reason: 'fixture'") => `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'\n      before-first-act: '${before}'\n  compliance:\n    ${compliance}\n---\nFollow this rule.\n`;
function harness(before = true) {
  resetForSelftest();
  const handlers = new Map();
  register((name, fn) => handlers.set(name, fn), { enabled: true });
  let body = text(before);
  const store = new Map();
  const $ = { env: { get: async (key) => key === 'CLAUDE_CONFIG_DIR' ? '/fixture-config' : undefined },
    fs: { list: async (dir) => dir === '/fixture-config/rules-on-demand' ? [{ kind: 'file', name: 'sample.md' }] : [], read: async () => body,
      stat: async (path) => ({ kind: 'file', size: 200, realPath: path }) },
    ui: { log: async () => {} }, session: { id: async () => 'fixture', messages: async () => [] },
    store: { get: async (key) => store.get(key), set: async (key, value) => store.set(key, value) } };
  const call = (args = {}, next = async () => ({})) => handlers.get('tool.call')($, { tool: 'Agent', cwd: '/fixture-project', ...args }, next);
  return { call, $, store, setBody: (value) => { body = value; } };
}

test('three concurrent refusals keep the second pending after first returns', async () => {
  const f = harness();
  let release;
  let entered;
  const enteredPromise = new Promise((resolve) => { entered = resolve; });
  const stalled = new Promise((resolve) => { release = resolve; });
  let logs = 0;
  f.$.ui.log = async () => { if (++logs === 2) { entered(); await stalled; } };
  let nextCalls = 0;
  const next = async () => { nextCalls++; return {}; };
  const first = f.call({}, next);
  const second = f.call({}, next);
  await enteredPromise;
  assert.match((await first).deny, /Follow this rule/);
  try { assert.match((await f.call({}, next)).deny, /Follow this rule/); assert.equal(nextCalls, 0); }
  finally { release(); await second; }
});

for (const before of [false, true]) test(`verdict store failure cannot lose ${before ? 'refusal' : 'ride-along'} delivery`, async () => {
  const f = harness(before);
  f.setBody(text(before, "kind: 'bash-command'\n    window: '1'\n    on-close: 'not applicable'\n    act-regex: 'run'\n    require-regex: 'yes'"));
  f.setBody((before ? text(true) : text(false)).replace("kind: 'none'\n    reason: 'fixture'", "kind: 'bash-command'\n    window: '1'\n    on-close: 'not applicable'\n    act-regex: 'run'\n    require-regex: 'yes'").replace("kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'", "kind: 'bash'\n      regex: 'run'"));
  f.$.store.set = async (key, value) => {
    if (key === 'compliance-verdicts-jsonl') throw new Error('store unavailable');
    f.store.set(key, value);
  };
  const result = await f.call({ tool: 'Bash', command: 'run yes' });
  assert.match(before ? result.deny : result.context?.join(''), /Follow this rule/);
});

test('nested unbounded regex is rejected naming rule and pattern', () => {
  for (const pattern of ['^(a+)+$', '(?:\\d*)*', '(a|a)*', '(a|ab)*', '(\\w+){2,}']) {
    assert.throws(() => parseRuntimeRule('sample.md', text().replace("tool: '^Agent$'", () => `tool: '${pattern}'`)), /sample\.md.*single unbounded element or overlapping alternation/);
  }
});
test('unsafe shipped adjacent trigger specs are refused, other specs parse', async () => {
  const dir = fileURLToPath(new URL('../../../plugin/rules/', import.meta.url));
  const names = (await readdir(dir)).filter((name) => name.endsWith('.spec.json'));
  assert.ok(names.length > 0);
  let refused = 0, accepted = 0;
  for (const name of names) {
    try { await readSpec(join(dir, name)); accepted++; }
    catch (error) { assert.match(error.message, /nested unbounded/, name); refused++; }
  }
  assert.ok(refused >= 4);
  assert.ok(accepted > 0);
});
test('foreign plugin data dir ignored, own plugin data dir honored', () => {
  assert.equal(qualityDataDir('/fixture-config', { CLAUDE_PLUGIN_DATA: '/fixture/other-plugin' }), resolve('/fixture-config', 'plugins', 'data', 'wt-rules-on-demand', 'quality'));
  assert.equal(qualityDataDir('/fixture-config', { CLAUDE_PLUGIN_DATA: '/fixture/wt-rules-on-demand_xyz' }), resolve('/fixture-config', 'plugins', 'data', 'wt-rules-on-demand', 'quality'));
  assert.equal(qualityDataDir('/fixture-config', { CLAUDE_PLUGIN_DATA: '/fixture/owned', CLAUDE_PLUGIN_ROOT: fileURLToPath(new URL('..', import.meta.url)) }), resolve('/fixture/owned', 'quality'));
});
test('transcript normalization keeps isolation argument for input-regex parity', () => {
  const [use] = normalize({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { isolation: 'worktree' } }] } }, 1);
  assert.match(JSON.stringify(use.input), /"isolation":"worktree"/);
  const trigger = parseRuntimeRule('sample.md', text().replace("unconditional: 'true'", "input-regex: 'isolation'")).triggers[0];
  assert.equal(triggerMatches(trigger, { channel: 'tool', tool: use.name, input: argumentEvidence(use.input) }), true);
  assert.equal(argumentEvidence({ long: 'x'.repeat(SUBJECT_CAP * 3), isolation: 'worktree' }).length <= SUBJECT_CAP, true);
  assert.match(argumentEvidence({ long: 'x'.repeat(SUBJECT_CAP * 3), isolation: 'worktree' }), /isolation/);
  const [nested] = normalize({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input: { isolation: 'worktree', nested: { secret: 'z'.repeat(SUBJECT_CAP * 4) } } }] } }, 1);
  assert.ok(JSON.stringify(nested).length < SUBJECT_CAP * 2);
  assert.match(nested.argumentEvidence, /isolation/);
});

test('configured delivery names do not prove runtime activity', () => {
  const rule = { name: 'sample.md' };
  const scope = { scope: 'user', rulesDir: '/config/rules-on-demand', rules: [rule] };
  const context = { events: [{ kind: 'delivery', name: 'sample.md', line: 1, provenance: { toolUseId: 'call' } }] };
  const resolved = resolveContext(context, [scope], { nonProofNames: ['sample.md'] });
  assert.equal(resolved.deliveries.length, 1);
  assert.equal(resolved.runtimeProofs.length, 0);
});

test('large subject is truncated consistently before trigger regex', () => {
  const trigger = parseRuntimeRule('sample.md', text().replace("kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'", "kind: 'prompt'\n      regex: 'MATCH$'")).triggers[0];
  assert.equal(triggerMatches(trigger, { channel: 'prompt', text: 'x'.repeat(SUBJECT_CAP + 1) + 'MATCH' }), false);
});

test('window one: test command consumes window before any edit', async () => {
  const f = harness(false);
  f.setBody(text(false, "kind: 'test-before-edit'\n    window: '1'\n    on-close: 'not applicable'\n    test-regex: 'pnpm test'\n    path-regex: 'file'").replace("kind: 'tool'\n      tool: '^Agent$'\n      unconditional: 'true'", "kind: 'prompt'\n      regex: 'start'"));
  const handlers = new Map();
  // The handler is registered in the harness; feed a prompt through a new harness for this case.
  resetForSelftest();
  register((name, fn) => handlers.set(name, fn), { enabled: true });
  await handlers.get('prompt.submit')(f.$, { cwd: '/fixture-project', text: 'start' }, async () => ({}));
  await f.call({ tool: 'Bash', command: 'pnpm test' });
  await f.call({ tool: 'Edit', path: 'file.md' });
  const rows = String(f.store.get('compliance-verdicts-jsonl') ?? '').trim().split('\n').filter(Boolean).map(JSON.parse);
  assert.deepEqual(rows.map((row) => row.verdict), ['not applicable']);
});

test('rollback ignores another project and legacy unattributed rows', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-attribution-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const projectA = join(root, 'project-a');
  const projectB = join(root, 'project-b');
  const config = join(root, 'config');
  const rule = text(false, "kind: 'bash-command'\n    window: '1'\n    on-close: 'not applicable'\n    act-regex: 'run'\n    require-regex: 'yes'");
  for (const project of [projectA, projectB]) {
    await mkdir(join(project, '.claude/rules-on-demand'), { recursive: true });
    await writeFile(join(project, '.claude/rules-on-demand/sample.md'), rule);
    await writeFile(join(project, '.claude/rules-on-demand-ledger.jsonl'), JSON.stringify({ action: 'migrate', rule: 'sample.md', time: new Date(Date.now() - 86400000).toISOString() }) + '\n');
  }
  const store = join(root, 'store.json');
  await writeFile(store, JSON.stringify({ 'compliance-verdicts-jsonl': [...Array(5)].map((_, i) => JSON.stringify({ rule: 'sample.md', ruleIdentity: i === 0 ? undefined : `project:${join(projectA, '.claude/rules-on-demand')}:sample.md`, verdict: 'not followed', decidedAt: new Date().toISOString() })).join('\n') }));
  const cli = fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [cli, '--project', projectB, '--store', store, '--dry-run', '--json'], { encoding: 'utf8', env: cleanEnv({ CLAUDE_CONFIG_DIR: config }) });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout)[0].action, 'none');
});

test('timeout targets worker group on POSIX and pid on Windows', () => {
  const calls = [];
  killWorker(123, 'SIGKILL', { platform: 'linux', kill: (...args) => calls.push(args) });
  killWorker(123, 'SIGKILL', { platform: 'win32', kill: (...args) => calls.push(args) });
  assert.deepEqual(calls, [[-123, 'SIGKILL'], [123, 'SIGKILL']]);
});

test('asynchronous watchdog spawn failure records failure and kills fake worker', async () => {
  const worker = new EventEmitter();
  worker.pid = 123;
  worker.unref = () => {};
  const watchdog = new EventEmitter();
  watchdog.unref = () => {};
  const killed = [];
  const reports = [];
  let calls = 0;
  launchQuality({ spawn: () => ++calls === 1 ? worker : watchdog, executable: 'node', args: [], watchdogArgs: () => [], env: {}, latestPath: 'latest.json',
    kill: (pid) => killed.push(pid), publish: async (_path, report) => { reports.push(report); } });
  watchdog.emit('error', new Error('supervisor unavailable'));
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(killed, [123]);
  assert.match(reports[0].error, /watchdog spawn: supervisor unavailable/);
  assert.equal(reports[0].ok, false);
});

test('startup follows mirrored files and reports dangling links', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-links-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = join(root, 'config');
  const project = join(root, 'project');
  await mkdir(join(config, 'rules-on-demand'), { recursive: true });
  await mkdir(join(project, '.claude/rules/wt'), { recursive: true });
  await writeFile(join(root, 'sample.md'), text());
  await symlink(join(root, 'sample.md'), join(config, 'rules-on-demand/sample.md'));
  await symlink(join(root, 'sample.md'), join(project, '.claude/rules/wt/sample.md'));
  await symlink(join(root, 'missing.md'), join(config, 'rules-on-demand/missing.md'));
  const script = fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url));
  const run = spawnSync(process.execPath, [script], { input: JSON.stringify({ source: 'startup', cwd: project }), encoding: 'utf8', env: cleanEnv({ CLAUDE_CONFIG_DIR: config, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1', CLAUDE_PLUGIN_OPTION_ENABLED: 'false' }) });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /same name, different rule: .*sample.md and .*sample.md/);
  assert.match(run.stdout, /dangling symlink .*missing.md/);
  assert.deepEqual(await readdir(config), ['rules-on-demand']);
});

test('runtime serves a profile with only a mirrored rule file', async () => {
  const f = harness();
  f.$.fs.list = async (dir) => dir === '/fixture-config/rules-on-demand' ? [{ kind: 'symlink', name: 'sample.md' }] : [];
  f.$.fs.stat = async () => ({ kind: 'file', size: 200 });
  assert.match((await f.call()).deny, /Follow this rule/);
});
