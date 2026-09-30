import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir, mkdtemp, mkdir, writeFile, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir, hostname } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { register, resetForSelftest } from '../hooks/hooks.js';
import { argumentEvidence } from '../hooks/evidence.js';
import { normalize } from '../scripts/transcript-verdicts.mjs';
import { migrateRule, qualityDataDir } from '../scripts/rule-lifecycle-lib.mjs';
import { launchQuality } from '../scripts/launch-quality.mjs';
import { cleanEnv } from './clean-env.mjs';

const fixture = `---\non-demand:\n  triggers:\n    - kind: 'tool'\n      tool: '^Agent$'\n      input-regex: '"run_in_background":false'\n      before-first-act: 'true'\n  compliance:\n    kind: 'model'\n    model: 'haiku'\n    prompt: 'Inspect arguments'\n    window: '1'\n    on-close: 'not applicable'\n---\nDifferent rule.\n`;
const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'none', reason: 'fixture' } };

test('every host capability in the hook import tree is directly called', async () => {
  const seen = new Set();
  const visit = async (url) => {
    if (seen.has(url.href)) return;
    seen.add(url.href);
    const source = await readFile(url, 'utf8');
    for (const match of source.matchAll(/\$\.[a-zA-Z_]\w*(?:\.[a-zA-Z_]\w*)*/g)) {
      if (match[0] === '$.plugin.root') continue; // documented metadata, not a capability
      assert.match(source.slice(match.index + match[0].length), /^\s*\(/, `${fileURLToPath(url)}: ${match[0]} must be directly called`);
    }
    for (const match of source.matchAll(/^import .* from ['"](\.[^'"]+)['"]/gm)) await visit(new URL(match[1], url));
  };
  await visit(new URL('../hooks/hooks.js', import.meta.url));
  assert.ok(seen.size >= 4);
});

test('same basename only suppresses equal bodies; runtime and startup agree', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-duplicate-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const config = join(root, 'config');
  const staticPath = join(project, '.claude/rules/sample.md');
  const demandPath = join(config, 'rules-on-demand/sample.md');
  await mkdir(join(project, '.claude/rules'), { recursive: true });
  await mkdir(join(config, 'rules-on-demand'), { recursive: true });
  await writeFile(demandPath, fixture);
  const startup = () => spawnSync(process.execPath, [fileURLToPath(new URL('../hooks/session-start.mjs', import.meta.url))], {
    input: JSON.stringify({ cwd: project, source: 'startup' }), encoding: 'utf8', env: cleanEnv({ CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_OPTION_ENABLED: 'false', CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' }),
  });
  const run = async () => {
    resetForSelftest();
    const handlers = new Map(), messages = [];
    register((name, fn) => handlers.set(name, fn), { enabled: true });
    const $ = { env: { get: async (key) => key === 'CLAUDE_CONFIG_DIR' ? config : undefined },
      fs: { list: async (dir) => readdir(dir, { withFileTypes: true }).then((entries) => entries.map((entry) => ({ name: entry.name, kind: entry.isDirectory() ? 'dir' : 'file', isLink: entry.isSymbolicLink() }))).catch(() => []),
        stat: async (path) => ({ kind: 'file', size: (await stat(path)).size, realPath: path }), read: (path) => readFile(path, 'utf8') },
      ui: { log: async (message) => messages.push(message) }, session: { id: async () => 'fixture' }, store: { get: async () => undefined, set: async () => {} } };
    const result = await handlers.get('tool.call')($, { tool: 'Agent', cwd: project, run_in_background: false }, async () => ({}));
    return { result, messages };
  };
  await writeFile(staticPath, 'Another rule.\n');
  assert.match(startup().stdout, /same name, different rule:/);
  assert.match((await run()).result.deny, /Different rule/);
  await writeFile(staticPath, '<!-- installed from fixture -->\r\nDifferent rule.  \r\n');
  assert.match(startup().stdout, /loaded twice:/);
  assert.equal((await run()).result.deny, undefined);
});

test('JSON evidence keeps primitive and nested types and reaches model classification', async () => {
  const input = { run_in_background: false, count: 7, nested: { enabled: true } };
  const serialized = JSON.stringify(input);
  assert.equal(argumentEvidence(input), serialized);
  const [use] = normalize({ type: 'assistant', message: { content: [{ type: 'tool_use', name: 'Agent', input }] } }, 1);
  assert.equal(argumentEvidence(use.input), serialized);
  resetForSelftest();
  const handlers = new Map(), prompts = [], store = new Map();
  register((name, fn) => handlers.set(name, fn), { enabled: true });
  const $ = { env: { get: async (key) => key === 'CLAUDE_CONFIG_DIR' ? '/fixture-config' : undefined },
    fs: { list: async (dir) => dir === '/fixture-config/rules-on-demand' ? [{ name: 'sample.md', kind: 'file' }] : [], stat: async () => ({ kind: 'file', size: 200, realPath: '/fixture-config/rules-on-demand' }), read: async () => fixture },
    ui: { log: async () => {} }, session: { id: async () => 'fixture' }, store: { get: async (key) => store.get(key), set: async (key, value) => store.set(key, value) }, model: { classify: async (prompt) => { prompts.push(prompt); return 'followed'; } } };
  assert.match((await handlers.get('tool.call')($, { tool: 'Agent', cwd: '/project', ...input }, async () => ({}))).deny, /Different rule/);
  await handlers.get('tool.call')($, { tool: 'Agent', cwd: '/project', ...input }, async () => ({}));
  assert.match(prompts.join(' '), /"run_in_background":false.*"count":7.*"nested":\{"enabled":true\}/);
  const identity = 'user:/fixture-config/rules-on-demand:sample.md';
  assert.ok(store.get('sessions').fixture.contexts['0'].servedIdentity[identity]);
  assert.equal(store.get('sessions').fixture.contexts['0'].governedActs[0].ruleIdentity, identity);
  assert.equal(JSON.parse(store.get('compliance-verdicts-jsonl')).ruleIdentity, identity);
});

test('live old owner cannot be reclaimed; dead same-host owner can', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-lock-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude/rules'), { recursive: true });
  await writeFile(join(root, '.claude/rules/sample.md'), 'Body\n');
  const lock = join(root, '.claude/rules-on-demand.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, hostname: hostname(), startedAt: Date.now() - 360000 }));
  await assert.rejects(() => migrateRule(root, 'sample.md', spec, {}), /lifecycle lock held/);
  assert.equal(JSON.parse(await readFile(lock, 'utf8')).pid, process.pid);
  await writeFile(lock, JSON.stringify({ pid: 99999999, hostname: hostname(), startedAt: Date.now() - 360000 }));
  await migrateRule(root, 'sample.md', spec, {});
});

test('second local migration waits behind a held lock after dead-owner reclaim', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-reclaimers-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude/rules'), { recursive: true });
  for (const name of ['first', 'second']) await writeFile(join(root, `.claude/rules/${name}.md`), 'Body\n');
  await writeFile(join(root, '.claude/rules-on-demand.lock'), JSON.stringify({ pid: 99999999, hostname: hostname(), startedAt: Date.now() - 360000 }));
  let release, entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const first = migrateRule(root, 'first.md', spec, {}, { io: { appendLedger: async (...args) => { entered(); await held; const { ledger } = await import('../scripts/rule-lifecycle-lib.mjs'); await ledger(...args); } } });
  await started;
  let secondEntered = false;
  const second = migrateRule(root, 'second.md', spec, {}, { io: { appendLedger: async (...args) => { secondEntered = true; const { ledger } = await import('../scripts/rule-lifecycle-lib.mjs'); await ledger(...args); } } });
  await new Promise((resolve) => setTimeout(resolve, 60));
  try { assert.equal(secondEntered, false); }
  finally { release(); }
  await Promise.all([first, second]);
});

test('partial destination write leaves no destination and keeps source', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-partial-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude/rules'), { recursive: true });
  await writeFile(join(root, '.claude/rules/sample.md'), 'Body\n');
  await assert.rejects(() => migrateRule(root, 'sample.md', spec, {}, { io: { writeDestination: async (path) => { await writeFile(path, 'partial', { flag: 'wx' }); throw new Error('disk full'); } } }), /disk full/);
  assert.equal(await readFile(join(root, '.claude/rules-on-demand/sample.md'), 'utf8').catch(() => null), null);
  assert.equal(await readFile(join(root, '.claude/rules/sample.md'), 'utf8'), 'Body\n');
});

test('synchronous watchdog spawn failure kills worker and publishes failure', async () => {
  const kills = [], reports = [];
  let calls = 0;
  await launchQuality({ spawn: () => {
    if (++calls === 2) throw new Error('unavailable');
    return { pid: 123, on: () => {}, unref: () => {} };
  }, executable: 'node', args: [], watchdogArgs: () => [], env: {}, latestPath: 'latest.json', kill: (pid) => kills.push(pid), publish: async (_path, report) => reports.push(report) });
  assert.deepEqual(kills, [123]);
  assert.match(reports[0].error, /watchdog spawn: unavailable/);
});

test('watchdog reaps group when leader exits on POSIX', async (t) => {
  if (process.platform === 'win32') { t.skip('POSIX process groups only'); return; }
  const root = await mkdtemp(join(tmpdir(), 'rod-watchdog-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const latest = join(root, 'latest.json');
  await writeFile(latest, JSON.stringify({ ok: true, finishedAt: new Date(Date.now() + 1000).toISOString() }));
  const scriptUrl = new URL('../scripts/quality-watchdog.mjs', import.meta.url).href;
  const code = `const calls=[]; process.argv=['node','watchdog','123',${JSON.stringify(latest)},'${Date.now()}']; process.kill=(pid,signal)=>{calls.push(pid); if(signal===0) throw Object.assign(new Error('gone'),{code:'ESRCH'});}; process.exit=()=>{throw new Error('STOP');}; try { await import(${JSON.stringify(scriptUrl)}); } catch(error) { if(error.message!=='STOP') throw error; console.log(JSON.stringify(calls)); }`;
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', code], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
  assert.deepEqual(JSON.parse(run.stdout.trim()), [123, -123]);
});

test('plugin data requires matching real plugin root, not a name prefix', () => {
  const fallback = resolve('/fixture-config', 'plugins', 'data', 'wt-rules-on-demand', 'quality');
  assert.equal(qualityDataDir('/fixture-config', { CLAUDE_PLUGIN_DATA: '/foreign/wt-rules-on-demand-helper' }), fallback);
  assert.equal(qualityDataDir('/fixture-config', { CLAUDE_PLUGIN_DATA: '/foreign/wt-rules-on-demand-helper', CLAUDE_PLUGIN_ROOT: '/foreign/plugin' }), fallback);
});

test('plugin data accepts a symlink resolving to its own root', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-own-root-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const alias = join(root, 'alias');
  await symlink(fileURLToPath(new URL('..', import.meta.url)), alias);
  assert.equal(qualityDataDir('/fixture-config', { CLAUDE_PLUGIN_ROOT: alias, CLAUDE_PLUGIN_DATA: join(root, 'data') }), join(root, 'data/quality'));
});
