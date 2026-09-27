import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, cp, symlink, readlink, stat, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readSpec, migrateRule, revertRule, retireRule, triggersHash } from '../scripts/rule-lifecycle-lib.mjs';
import { cleanEnv } from './clean-env.mjs';

const cli = fileURLToPath(new URL('../scripts/rules.mjs', import.meta.url));
const quality = fileURLToPath(new URL('../scripts/quality-check.mjs', import.meta.url));
const rollback = fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url));
const realRule = fileURLToPath(new URL('../../../plugin/rules/wt-delegation-ladder-at-act.md', import.meta.url));
const realSpec = fileURLToPath(new URL('../../../plugin/rules/wt-delegation-ladder-at-act.spec.json', import.meta.url));
const name = 'wt-delegation-ladder-at-act.md';
async function sandbox(t) {
  const root = await mkdtemp(join(tmpdir(), 'rod-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude/rules/wt'), { recursive: true });
  await cp(realRule, join(root, '.claude/rules/wt', name));
  return root;
}
async function tree(root) {
  const entries = [];
  const scan = async (dir, prefix = '') => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const name = join(prefix, entry.name);
      const path = join(dir, entry.name);
      if (entry.isDirectory()) { entries.push([name, 'directory']); await scan(path, name); }
      else if (entry.isSymbolicLink()) entries.push([name, 'symlink', await readlink(path)]);
      else entries.push([name, 'file', (await readFile(path)).toString('base64')]);
    }
  };
  await scan(root);
  return entries.sort((a, b) => a[0].localeCompare(b[0]));
}

test('real adjacent trigger spec migrates unchanged real rule body, reverts and retires into archive', async (t) => {
  const root = await sandbox(t);
  const spec = await readSpec(realSpec);
  const source = join(root, '.claude/rules/wt', name);
  const body = await readFile(source, 'utf8');
  const result = await migrateRule(root, `wt/${name}`, spec, { unproven: true, noProofReason: 'fixture' });
  assert.equal(await readFile(result.destination, 'utf8').then((text) => text.endsWith(body)), true);
  assert.equal(await readFile(source, 'utf8').catch(() => null), null);
  await revertRule(root, name);
  assert.equal(await readFile(source, 'utf8'), body);
  const archive = await retireRule(root, `wt/${name}`, 'superseded');
  assert.match(archive, /rules-archive\/\d{4}-\d\d-\d\d-wt\/wt-delegation-ladder-at-act\.md$/);
  assert.equal(await readFile(archive, 'utf8'), body);
  assert.match(await readFile(join(root, '.claude/rules-on-demand-ledger.jsonl'), 'utf8'), /"action":"retire".*"time":/);
  await assert.rejects(() => retireRule(root, `wt/${name}`, ''), /requires --reason/);
});

test('proof binds body, scope and every trigger; named override is unproven', async (t) => {
  const root = await sandbox(t);
  const body = await readFile(join(root, '.claude/rules/wt', name));
  const spec = await readSpec(realSpec);
  const proof = join(root, 'proof.json');
  const report = { rule: name, scopeRoot: root, bodyHash: createHash('sha256').update(body).digest('hex'), triggersHash: triggersHash(spec.triggers), byTrigger: spec.triggers.map(() => ({ matches: 1 })) };
   const run = () => spawnSync(process.execPath, [cli, 'migrate', `wt/${name}`, '--project', root, '--spec', realSpec, '--proof', proof], { encoding: 'utf8', env: cleanEnv() });
  await writeFile(proof, JSON.stringify({ ...report, scopeRoot: '/other' }));
  assert.match(run().stderr, /scope root/);
  await writeFile(proof, JSON.stringify({ ...report, byTrigger: [{ matches: 0 }, ...report.byTrigger.slice(1)] }));
  assert.match(run().stderr, /zero matches for triggers: 0/);
  await writeFile(proof, JSON.stringify(report));
  assert.equal(run().status, 0);
});

test('user migration requires enabled plugin and Function Hooks for every profile', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-user-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mirror = join(root, 'mirror');
  const primary = join(root, 'primary');
  for (const dir of [primary, mirror]) await mkdir(join(dir, 'rules'), { recursive: true });
  await writeFile(join(primary, 'rules', name), await readFile(realRule));
  const args = [cli, 'migrate', name, '--user', '--config-dir', primary, '--mirror-dir', mirror, '--spec', realSpec, '--no-proof', 'fixture'];
   const run = (...rest) => spawnSync(process.execPath, [...args, ...rest], { encoding: 'utf8', env: cleanEnv({ CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0' }) });
  assert.match(run().stderr, /profile .*primary: settings.json missing/);
  await writeFile(join(primary, 'settings.json'), JSON.stringify({ enabledPlugins: { 'wt-rules-on-demand@local': true }, env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } }));
  assert.match(run().stderr, /profile .*mirror: settings.json missing/);
  assert.equal(run('--assume-loaded', mirror).status, 0);
  const ledger = await readFile(join(primary, 'rules-on-demand-ledger.jsonl'), 'utf8');
  assert.match(ledger, /"assumedLoaded":\[".*mirror"\]/);
});

test('failed mirror application rolls back destination and preserves source and ledger', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-mirror-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, 'primary');
  const mirror = join(root, 'mirror');
  for (const dir of [primary, mirror]) await mkdir(join(dir, 'rules'), { recursive: true });
  const source = join(primary, 'rules/example.md');
  await writeFile(source, 'Sample\n');
  await symlink(source, join(mirror, 'rules/example.md'));
  await writeFile(join(mirror, 'rules-on-demand'), 'blocked parent');
  const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'none', reason: 'fixture' } };
  await assert.rejects(() => migrateRule(primary, 'example.md', spec, { unproven: true }, { scope: 'user', mirrorDirs: [mirror] }), /apply mirrors: mirror/);
  assert.equal(await readFile(source, 'utf8'), 'Sample\n');
  assert.equal(await readlink(join(mirror, 'rules/example.md')), source);
  assert.equal(await readFile(join(primary, 'rules-on-demand/example.md'), 'utf8').catch(() => null), null);
  assert.equal(await readFile(join(primary, 'rules-on-demand-ledger.jsonl'), 'utf8').catch(() => null), null);
});

test('ledger failure cannot remove the source or leave a destination', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-ledger-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude/rules'), { recursive: true });
   await writeFile(join(root, '.claude/rules/sample.md'), 'Sample\n');
   const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'none', reason: 'fixture' } };
   let existedAtAppend = false;
   await assert.rejects(() => migrateRule(root, 'sample.md', spec, { unproven: true }, { io: {
     appendLedger: async () => { existedAtAppend = (await stat(join(root, '.claude/rules-on-demand/sample.md'))).isFile(); throw new Error('injected append failure'); },
   } }), /append ledger: injected append failure/);
   assert.equal(existedAtAppend, true);
  assert.equal(await readFile(join(root, '.claude/rules/sample.md'), 'utf8'), 'Sample\n');
  assert.equal(await readFile(join(root, '.claude/rules-on-demand/sample.md'), 'utf8').catch(() => null), null);
});

test('EEXIST at destination creation never removes another invocation’s file', async (t) => {
  const root = await sandbox(t);
  const spec = await readSpec(realSpec);
  const destination = join(root, '.claude/rules-on-demand', name);
  await assert.rejects(() => migrateRule(root, `wt/${name}`, spec, {}, { io: {
     writeDestination: async (path) => { await writeFile(destination, 'other transaction', { flag: 'wx' }); await writeFile(path, 'ours', { flag: 'wx' }); },
   } }), /destination exists/);
  assert.equal(await readFile(destination, 'utf8'), 'other transaction');
  assert.ok(await readFile(join(root, '.claude/rules/wt', name)));
});

test('two concurrent migrations serialize their ledger entries', async (t) => {
  const root = await sandbox(t);
  const spec = await readSpec(realSpec);
  await writeFile(join(root, '.claude/rules/wt/second.md'), 'Second\n');
  let release;
  let entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  const first = migrateRule(root, `wt/${name}`, spec, {}, { io: { appendLedger: async (...args) => { entered(); await held; const { ledger } = await import('../scripts/rule-lifecycle-lib.mjs'); await ledger(...args); } } });
  await started;
  const second = migrateRule(root, 'wt/second.md', spec, {});
  release();
  await Promise.all([first, second]);
  const lines = (await readFile(join(root, '.claude/rules-on-demand-ledger.jsonl'), 'utf8')).trim().split('\n').map(JSON.parse);
  assert.deepEqual(lines.map((row) => row.rule), [name, 'second.md']);
});

test('held lifecycle lock is refused with a legible message', async (t) => {
  const root = await sandbox(t);
  const lock = join(root, '.claude/rules-on-demand.lock');
  await writeFile(lock, 'held');
  const spec = await readSpec(realSpec);
  await assert.rejects(() => migrateRule(root, `wt/${name}`, spec, {}), /lifecycle lock held/);
  assert.equal(await readFile(lock, 'utf8'), 'held');
});

test('stale lifecycle lock is reclaimed and reported', async (t) => {
  const root = await sandbox(t);
  const lock = join(root, '.claude/rules-on-demand.lock');
   await writeFile(lock, JSON.stringify({ pid: 99999999, hostname: 'remote-host', startedAt: Date.now() - 6 * 60_000 }));
  const old = new Date(Date.now() - 6 * 60_000);
  await utimes(lock, old, old);
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  try { await migrateRule(root, `wt/${name}`, await readSpec(realSpec), {}); }
  finally { console.warn = warn; }
  assert.match(warnings.join('\n'), /reclaimed stale lifecycle lock/);
});

test('revert user rule succeeds after the engine is disabled', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-disabled-revert-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  await mkdir(join(profile, 'rules'), { recursive: true });
  await writeFile(join(profile, 'rules/example.md'), 'Body\n');
  const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'none', reason: 'fixture' } };
  await migrateRule(profile, 'example.md', spec, {}, { scope: 'user' });
  const result = spawnSync(process.execPath, [cli, 'revert', 'example.md', '--user', '--config-dir', profile], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(await readFile(join(profile, 'rules/example.md'), 'utf8'), 'Body\n');
});

test('manual rollback publishes its report under owned plugin data', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-rollback-data-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const config = join(root, 'config');
   const data = join(root, 'wt-rules-on-demand-fixture');
  await mkdir(join(project, '.claude/rules'), { recursive: true });
  await writeFile(join(project, '.claude/rules/sample.md'), 'Sample\n');
  await migrateRule(project, 'sample.md', { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: {
    kind: 'bash-command', window: 1, 'on-close': 'not applicable', 'act-regex': 'run', 'require-regex': 'yes',
  } }, {});
  const store = join(root, 'store.json');
  const ruleIdentity = `project:${join(project, '.claude/rules-on-demand')}:sample.md`;
  await writeFile(store, JSON.stringify({ 'compliance-verdicts-jsonl': Array.from({ length: 5 }, () => JSON.stringify({ rule: 'sample.md', ruleIdentity, verdict: 'not followed', decidedAt: new Date().toISOString() })).join('\n') }));
   const result = spawnSync(process.execPath, [rollback, '--project', project, '--store', store, '--json'], { encoding: 'utf8', env: cleanEnv({ CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: fileURLToPath(new URL('..', import.meta.url)) }) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].action, 'reverted');
  assert.equal(JSON.parse(await readFile(join(data, 'quality/rollback-latest.json'), 'utf8')).reverted[0].rule, 'sample.md');
});

test('retire honours an explicit static subpath when an on-demand basename also exists', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-retire-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(join(root, '.claude/rules/wt'), { recursive: true });
  await mkdir(join(root, '.claude/rules-on-demand'), { recursive: true });
  await writeFile(join(root, '.claude/rules/wt/example.md'), 'static version\n');
  await writeFile(join(root, '.claude/rules-on-demand/example.md'), 'on-demand version\n');
  const archived = await retireRule(root, 'wt/example.md', 'superseded');
  assert.equal(await readFile(archived, 'utf8'), 'static version\n');
  assert.equal(await readFile(join(root, '.claude/rules-on-demand/example.md'), 'utf8'), 'on-demand version\n');
});

test('daily quality check is dry-run and leaves entire project rule tree and ledger unchanged', async (t) => {
  const root = await sandbox(t);
  const config = join(root, 'config');
  const data = join(config, 'plugins/data/wt-rules-on-demand/quality');
  const spec = await readSpec(realSpec);
  await migrateRule(root, `wt/${name}`, spec, { unproven: true });
  const before = await readFile(join(root, '.claude/rules-on-demand', name));
  const ledger = await readFile(join(root, '.claude/rules-on-demand-ledger.jsonl'));
   const run = spawnSync(process.execPath, [quality, '--project', root, '--config-dir', config, '--data-dir', data], { encoding: 'utf8', env: cleanEnv() });
  assert.notEqual(run.status, 0); // no transcripts: a failed scan, not a clean result
  assert.equal((await readFile(join(data, 'latest.json'), 'utf8')).includes('"ok": false'), true);
  assert.deepEqual(await readFile(join(root, '.claude/rules-on-demand', name)), before);
  assert.deepEqual(await readFile(join(root, '.claude/rules-on-demand-ledger.jsonl')), ledger);
});

test('unattributed dry-run needs attention and leaves rule and ledger byte-identical', async (t) => {
  const root = await sandbox(t);
  const config = join(root, 'config');
  const spec = await readSpec(realSpec);
  const destination = (await migrateRule(root, `wt/${name}`, spec, { unproven: true })).destination;
  const sourceBefore = await readFile(destination);
  const ledgerFile = join(root, '.claude/rules-on-demand-ledger.jsonl');
  const ledgerBefore = await readFile(ledgerFile);
  const store = join(root, 'store.json');
   await writeFile(store, JSON.stringify({ sessions: { sample: { last: new Date(Date.now() + 1000).toISOString(), contexts: { '0': { governedActs: [{ rule: name, ruleIdentity: `project:${join(root, '.claude/rules-on-demand')}:${name}`, at: new Date(Date.now() + 1000).toISOString() }] } } } } }));
   const run = spawnSync(process.execPath, [rollback, '--project', root, '--store', store, '--dry-run', '--json'], { encoding: 'utf8', env: cleanEnv({ CLAUDE_CONFIG_DIR: config }) });
  assert.equal(run.status, 0, run.stderr);
   assert.equal(JSON.parse(run.stdout)[0].action, 'attention');
  assert.deepEqual(await readFile(destination), sourceBefore);
  assert.deepEqual(await readFile(ledgerFile), ledgerBefore);
  assert.deepEqual(await readdir(join(root, '.claude/rules-on-demand')), [name]);
});

test('unattributed user dry-run preserves mirror links and ledgers', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-dry-mirror-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, 'primary');
  const mirror = join(root, 'mirror');
  const project = join(root, 'project');
  for (const dir of [primary, mirror]) await mkdir(join(dir, 'rules'), { recursive: true });
  await mkdir(project);
  const rule = 'sample.md';
  await writeFile(join(primary, 'rules', rule), 'Check model.\n');
  await symlink(join(primary, 'rules', rule), join(mirror, 'rules', rule));
  const spec = { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'none', reason: 'fixture' } };
  await migrateRule(primary, rule, spec, { unproven: true }, { scope: 'user', mirrorDirs: [mirror] });
  const destination = join(primary, 'rules-on-demand', rule);
  const mirrorLink = join(mirror, 'rules-on-demand', rule);
  const before = await readFile(destination);
  const linkBefore = await readlink(mirrorLink);
  const ledgerBefore = await readFile(join(primary, 'rules-on-demand-ledger.jsonl'));
  const store = join(root, 'store.json');
   await writeFile(store, JSON.stringify({ sessions: { sample: { last: new Date(Date.now() + 1000).toISOString(), contexts: { '0': { governedActs: [{ rule, ruleIdentity: `user:${join(primary, 'rules-on-demand')}:${rule}`, at: new Date(Date.now() + 1000).toISOString() }] } } } } }));
   const run = spawnSync(process.execPath, [rollback, '--user', '--config-dir', primary, '--project', project, '--mirror-dir', mirror, '--store', store, '--dry-run', '--json'], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
   assert.equal(JSON.parse(run.stdout)[0].action, 'attention');
  assert.deepEqual(await readFile(destination), before);
  assert.equal(await readlink(mirrorLink), linkBefore);
  assert.deepEqual(await readFile(join(primary, 'rules-on-demand-ledger.jsonl')), ledgerBefore);
});

test('quality report identifies explicitly unproven migrations without editing their rule', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-quality-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const config = join(root, 'config');
  const projects = join(config, 'projects');
  await mkdir(join(project, '.claude/rules'), { recursive: true });
  await mkdir(projects, { recursive: true });
  await writeFile(join(project, '.claude/rules/sample.md'), 'Check agent model.\n');
  await migrateRule(project, 'sample.md', { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'check', check: 'agent-model' } }, { noProofReason: 'no historical transcript', unproven: true });
  const file = join(project, '.claude/rules-on-demand/sample.md');
  const before = await readFile(file);
  const ledgerBefore = await readFile(join(project, '.claude/rules-on-demand-ledger.jsonl'));
  await writeFile(join(projects, 'sample.jsonl'), JSON.stringify({ type: 'assistant', cwd: project, timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'fixture-agent', name: 'Agent', input: { model: 'sonnet' } }] } }) + '\n');
  const data = join(config, 'plugins/data/wt-rules-on-demand/quality');
   const run = spawnSync(process.execPath, [quality, '--project', project, '--config-dir', config, '--data-dir', data], { encoding: 'utf8', timeout: 60_000, env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(await readFile(join(data, 'latest.json'), 'utf8'));
  assert.equal(report.ok, true);
  assert.ok(!(await readdir(data)).some((name) => name.endsWith('.tmp')));
  assert.deepEqual(report.unproven, [{ scope: 'project', rule: 'sample.md', reason: 'no historical transcript' }]);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(join(project, '.claude/rules-on-demand-ledger.jsonl')), ledgerBefore);
});

test('automatic quality pipeline reports would-revert but leaves entire rule tree untouched', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-daily-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const config = join(root, 'config');
  await mkdir(join(project, '.claude/rules'), { recursive: true });
  await mkdir(join(config, 'projects'), { recursive: true });
  await writeFile(join(project, '.claude/rules/sample.md'), 'Choose a model.\n');
  await migrateRule(project, 'sample.md', { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'check', check: 'agent-model', 'rollback-min-samples': 5 } }, { unproven: true });
  const file = join(project, '.claude/rules-on-demand/sample.md');
  const ledgerFile = join(project, '.claude/rules-on-demand-ledger.jsonl');
  const before = await readFile(file);
  const ledgerBefore = await readFile(ledgerFile);
  const treeBefore = await tree(join(project, '.claude'));
  const at = new Date().toISOString();
  const records = [
    { type: 'attachment', cwd: project, timestamp: at, attachment: { type: 'hook_additional_context', content: '<rule name="sample.md">\nChoose a model.\n</rule>', toolUseID: 'fixture-context' } },
    ...Array.from({ length: 8 }, (_, i) => ({ type: 'assistant', cwd: project, timestamp: at, message: { content: [{ type: 'tool_use', id: `fixture-${i}`, name: 'Agent', input: { prompt: 'work' } }] } })),
  ];
  await writeFile(join(config, 'projects/sample.jsonl'), records.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const data = join(config, 'plugins/data/wt-rules-on-demand/quality');
   const run = spawnSync(process.execPath, [quality, '--project', project, '--config-dir', config, '--data-dir', data], { encoding: 'utf8', timeout: 60_000, env: cleanEnv() });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(await readFile(join(data, 'latest.json'), 'utf8'));
  assert.equal(report.rollback[0]?.action, 'would revert');
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(ledgerFile), ledgerBefore);
  assert.deepEqual(await tree(join(project, '.claude')), treeBefore);
});
