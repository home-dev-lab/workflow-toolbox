import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, readdir, rm, cp, symlink, readlink, stat, utimes, realpath } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { readSpec, migrateRule, revertRule, retireRule, triggersHash } from '../scripts/rule-lifecycle-lib.mjs';
import { externalTest } from './external-test.mjs';

test('JSON migration specs accept boolean and string unconditional values', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-unconditional-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const path = join(root, 'spec.json');
  for (const value of [true, 'true', 'false']) {
    await writeFile(path, JSON.stringify({ 'on-demand': { triggers: [{ kind: 'tool', tool: '^Edit$', unconditional: value }] }, compliance: { kind: 'none', reason: 'fixture' } }));
    if (value === 'false') await assert.rejects(readSpec(path), /tool trigger requires/);
    else assert.equal((await readSpec(path)).triggers[0].unconditional, value);
  }
});
test('transcript evidence before last migration cannot trigger mechanical rollback', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-cutoff-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'rules-on-demand');
  await mkdir(directory);
  await writeFile(join(directory, 'sample.md'), "---\non-demand:\n  triggers:\n    - kind: tool\n      tool: ^Agent$\n      unconditional: true\n  compliance:\n    kind: check\n    check: agent-model\n---\nReview.\n");
  const cutoff = new Date(Date.now() - 86400000).toISOString();
  await writeFile(join(root, 'rules-on-demand-ledger.jsonl'), JSON.stringify({ action: 'migrate', rule: 'sample.md', time: cutoff }) + '\n');
  const verdicts = join(root, 'verdicts.jsonl');
  const rows = (at) => Array.from({ length: 5 }, (_, index) => JSON.stringify({ rule: 'sample.md', scope: 'user', rulesDir: directory, verdict: 'not followed', at, line: index + 1 })).join('\n') + '\n';
  // Static baseline measured before the migration: the rule was followed then, so a lower on-demand rate reverts.
  const baseline = Array.from({ length: 5 }, (_, index) => JSON.stringify({ rule: 'sample.md', scope: 'user', rulesDir: directory, phase: 'before', verdict: 'static baseline', checkVerdict: 'followed', at: new Date(Date.now() - 259200000).toISOString(), line: 100 + index })).join('\n') + '\n';
  const run = () => spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url)), '--user', '--config-dir', root, '--verdicts', verdicts, '--mechanical-only', '--dry-run', '--json'], { encoding: 'utf8' });
  await writeFile(verdicts, baseline + rows(new Date(Date.now() - 172800000).toISOString()));
  assert.equal(JSON.parse(run().stdout)[0].action, 'none');
  await writeFile(verdicts, baseline + rows(new Date().toISOString()));
  assert.equal(JSON.parse(run().stdout)[0].action, 'would revert');
});
test('rollback reads bounded external verdict archives by rule identity', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-archive-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const directory = join(root, 'rules-on-demand');
  await mkdir(directory);
  await writeFile(join(directory, 'sample.md'), "---\non-demand:\n  triggers:\n    - kind: tool\n      tool: ^Agent$\n      unconditional: true\n  compliance:\n    kind: model\n    model: haiku\n    window: 1\n    on-close: not applicable\n---\nReview.\n");
  await writeFile(join(root, 'rules-on-demand-ledger.jsonl'), JSON.stringify({ action: 'migrate', rule: 'sample.md', time: new Date(Date.now() - 86400000).toISOString() }) + '\n');
  const archive = join(root, 'plugins', 'data', 'wt-rules-on-demand', 'quality');
  await mkdir(archive, { recursive: true });
  const id = `user:${directory}:sample.md`;
  await writeFile(join(archive, 'compliance-verdicts-archive-1000-1.jsonl'), Array.from({ length: 5 }, () => JSON.stringify({ rule: 'sample.md', ruleIdentity: id, verdict: 'not followed', decidedAt: new Date().toISOString() })).join('\n') + '\n');
  const store = join(root, 'store.json');
  await writeFile(store, JSON.stringify({ 'compliance-verdicts-jsonl': '' }));
  // A model-judged rule keeps reading store and archive verdicts; the transcript file only carries the static baseline.
  const baseline = join(root, 'baseline.jsonl');
  await writeFile(baseline, Array.from({ length: 5 }, (_, index) => JSON.stringify({ rule: 'sample.md', scope: 'user', rulesDir: directory, phase: 'before', verdict: 'static baseline', checkVerdict: 'followed', at: new Date(Date.now() - 259200000).toISOString(), line: index + 1 })).join('\n') + '\n');
  const run = spawnSync(process.execPath, [fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url)), '--user', '--config-dir', root, '--store', store, '--verdicts', baseline, '--dry-run', '--json'], { encoding: 'utf8' });
  assert.equal(run.status, 0, run.stderr);
  assert.equal(JSON.parse(run.stdout)[0].action, 'would revert');
});
import { cleanEnv, managedPolicyArgs } from './clean-env.mjs';
import { installFixture } from '../test-support/profile-fixture.mjs';

const cli = fileURLToPath(new URL('../scripts/rules.mjs', import.meta.url));
const quality = fileURLToPath(new URL('../scripts/quality-check.mjs', import.meta.url));
const rollback = fileURLToPath(new URL('../scripts/rollback-check.mjs', import.meta.url));
const ruleTest = externalTest('../../../plugin/rules/wt-delegation-ladder-at-act.md', import.meta.url);
const realSpec = fileURLToPath(new URL('./fixtures/lifecycle.spec.json', import.meta.url));
const name = 'wt-delegation-ladder-at-act.md';
async function sandbox(t, realRule) {
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

const legacyVerdict = JSON.stringify({ rule: 'sample.md', verdict: 'not followed' }) + '\n';
async function qualityEnvironment(root, config) {
  const home = join(root, 'home');
  const storeDir = join(config, 'plugins/store');
  const ambientStoreDir = join(home, '.claude/plugins/store');
  for (const directory of [storeDir, ambientStoreDir]) await mkdir(directory, { recursive: true });
  await writeFile(join(storeDir, 'wt-rules-on-demand_fixture.json'), '{}');
  const ambientStore = join(ambientStoreDir, 'wt-rules-on-demand_fixture.json');
  // A legacy default store makes accidental fallback observable even when it exits successfully.
  await writeFile(ambientStore, JSON.stringify({ 'compliance-verdicts-jsonl': legacyVerdict }));
  return { ambientStore, env: cleanEnv({ HOME: home, USERPROFILE: home, CLAUDE_CONFIG_DIR: config }) };
}

test('project rollback resolves default stores and archives inside its temporary home', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-default-inputs-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  await mkdir(join(project, '.claude/rules-on-demand'), { recursive: true });
  await writeFile(join(project, '.claude/rules-on-demand/sample.md'), 'Sample\n');
  const verdicts = join(root, 'verdicts.jsonl');
  await writeFile(verdicts, '');
  const { env, ambientStore } = await qualityEnvironment(root, join(root, 'config'));
  const fallback = cleanEnv({ HOME: env.HOME, USERPROFILE: env.USERPROFILE });
  const run = (env) => spawnSync(process.execPath, [rollback, '--project', project, '--dry-run', '--json', '--verdicts', verdicts], { encoding: 'utf8', env });
  const legacyOnly = run(fallback);
  assert.equal(legacyOnly.status, 0, legacyOnly.stderr);
  assert.match(legacyOnly.stderr, /legacy rows skipped: 1/);
  const archives = join(env.HOME, '.claude/plugins/data/wt-rules-on-demand/quality');
  await mkdir(archives, { recursive: true });
  await writeFile(join(archives, 'compliance-verdicts-archive-1000-1.jsonl'), legacyVerdict);
  await writeFile(ambientStore, 'not-json');
  const unreadable = run(fallback);
  assert.equal(unreadable.status, 1, unreadable.stderr);
  assert.match(unreadable.stderr, /legacy rows skipped: 1/);
  assert.deepEqual(JSON.parse(unreadable.stdout)[0].unreadableStores.map((row) => row.path), [ambientStore]);
  const pinned = run(env);
  assert.equal(pinned.status, 0, pinned.stderr);
  assert.equal(pinned.stderr, '');
});

ruleTest('safe trigger spec migrates unchanged real rule body, reverts and retires into archive', async (t, realRule) => {
  const root = await sandbox(t, realRule);
  const spec = await readSpec(realSpec);
  const source = join(root, '.claude/rules/wt', name);
  const body = await readFile(source, 'utf8');
  const result = await migrateRule(root, `wt/${name}`, spec, { unproven: true, noProofReason: 'fixture' });
  assert.equal(await readFile(result.destination, 'utf8').then((text) => text.endsWith(body)), true);
  assert.equal(await readFile(source, 'utf8').catch(() => null), null);
  await revertRule(root, name);
  assert.equal(await readFile(source, 'utf8'), body);
  const archive = await retireRule(root, `wt/${name}`, 'superseded');
  assert.match(archive.replaceAll('\\', '/'), /rules-archive\/\d{4}-\d\d-\d\d-wt\/wt-delegation-ladder-at-act\.md$/);
  assert.equal(await readFile(archive, 'utf8'), body);
  assert.match(await readFile(join(root, '.claude/rules-on-demand-ledger.jsonl'), 'utf8'), /"action":"retire".*"time":/);
  const last = JSON.parse((await readFile(join(root, '.claude/rules-on-demand-ledger.jsonl'), 'utf8')).trim().split('\n').at(-1));
  assert.equal(last.rule, name);
  assert.equal(last.from, '.claude/rules/wt/' + name);
  await assert.rejects(() => retireRule(root, `wt/${name}`, ''), /requires --reason/);
});

ruleTest('proof binds body, scope and every trigger; named override is unproven', async (t, realRule) => {
  const root = await sandbox(t, realRule);
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

ruleTest('project migration records the --config-dir profile, not the environment one', async (t, realRule) => {
  const root = await sandbox(t, realRule);
  const environmentProfile = join(root, 'profile-env'), selectedProfile = join(root, 'profile-selected');
  for (const dir of [environmentProfile, selectedProfile]) await mkdir(dir, { recursive: true });
  const run = spawnSync(process.execPath, [cli, 'migrate', `wt/${name}`, '--project', root, '--config-dir', selectedProfile, '--spec', realSpec, '--no-proof', 'fixture'],
    { encoding: 'utf8', env: cleanEnv({ CLAUDE_CONFIG_DIR: environmentProfile }) });
  assert.equal(run.status, 0, run.stderr);
  const migration = JSON.parse((await readFile(join(root, '.claude/rules-on-demand-ledger.jsonl'), 'utf8')).trim().split('\n').at(-1));
  // The ledger keeps the profile as named; its physical identity is recorded beside it (macOS /var and Windows 8.3 temp paths differ).
  assert.deepEqual(migration.profiles, [resolve(selectedProfile)], 'the profile named on the command line is the one required to serve');
  assert.deepEqual(migration.profileIdentities.map((row) => row.physical), [await realpath(selectedProfile)], 'its physical identity is the selected profile, not the environment one');
});

ruleTest('user migration requires enabled plugin and Function Hooks for every profile', async (t, realRule) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-user-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const mirror = join(root, 'mirror');
  const primary = join(root, 'primary');
  for (const dir of [primary, mirror]) { await mkdir(join(dir, 'rules'), { recursive: true }); await installFixture(dir); }
  await writeFile(join(primary, 'rules', name), await readFile(realRule));
  const args = [...managedPolicyArgs, cli, 'migrate', name, '--user', '--config-dir', primary, '--mirror-dir', mirror, '--spec', realSpec, '--no-proof', 'fixture'];
   const run = (...rest) => spawnSync(process.execPath, [...args, ...rest], { encoding: 'utf8', env: cleanEnv({ CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0' }) });
  assert.match(run().stderr, /profile .*primary.*engine not enabled/);
  await writeFile(join(primary, 'settings.json'), JSON.stringify({ enabledPlugins: { 'wt-rules-on-demand@local': true }, pluginConfigs: { 'wt-rules-on-demand@local': { options: { enabled: true } } }, env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } }));
  assert.match(run().stderr, /profile .*mirror.*engine not enabled/);
  await writeFile(join(mirror, 'settings.json'), JSON.stringify({ enabledPlugins: { 'wt-rules-on-demand@local': true }, pluginConfigs: { 'wt-rules-on-demand@local': { options: { enabled: true } } }, env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } }));
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

ruleTest('EEXIST at destination creation never removes another invocation’s file', async (t, realRule) => {
  const root = await sandbox(t, realRule);
  const spec = await readSpec(realSpec);
  const destination = join(root, '.claude/rules-on-demand', name);
  await assert.rejects(() => migrateRule(root, `wt/${name}`, spec, {}, { io: {
     writeDestination: async (path) => { await writeFile(destination, 'other transaction', { flag: 'wx' }); await writeFile(path, 'ours', { flag: 'wx' }); },
   } }), /destination exists/);
  assert.equal(await readFile(destination, 'utf8'), 'other transaction');
  assert.ok(await readFile(join(root, '.claude/rules/wt', name)));
});

ruleTest('a held local lock makes a second migration wait in the common case', async (t, realRule) => {
  const root = await sandbox(t, realRule);
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

ruleTest('held lifecycle lock is refused with a legible message', async (t, realRule) => {
  const root = await sandbox(t, realRule);
  const lock = join(root, '.claude/rules-on-demand.lock');
  await writeFile(lock, 'held');
  const spec = await readSpec(realSpec);
  await assert.rejects(() => migrateRule(root, `wt/${name}`, spec, {}), /lifecycle lock held/);
  assert.equal(await readFile(lock, 'utf8'), 'held');
});

ruleTest('stale lifecycle lock is reclaimed and reported', async (t, realRule) => {
  const root = await sandbox(t, realRule);
  const lock = join(root, '.claude/rules-on-demand.lock');
   await writeFile(lock, JSON.stringify({ pid: 99999999, hostname: 'remote-host', startedAt: Date.now() - 6 * 60_000 }));
  const old = new Date(Date.now() - 6 * 60_000);
  await utimes(lock, old, old);
  const warnings = [];
  const warn = console.warn;
  console.warn = (message) => warnings.push(message);
  try { await migrateRule(root, `wt/${name}`, await readSpec(realSpec), {}); }
  finally { console.warn = warn; }
  assert.match(warnings.join('\n'), /reclaimed apparently stale lifecycle lock/);
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
  const exposureDir = join(config, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(exposureDir, { recursive: true });
  await writeFile(join(project, '.claude/rules/sample.md'), 'Sample\n');
  await migrateRule(project, 'sample.md', { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: {
    kind: 'bash-command', window: 1, 'on-close': 'not applicable', 'act-regex': 'run', 'require-regex': 'yes',
  } }, {}, { configDir: config });
  const exposureFile = join(exposureDir, 'exposure.jsonl'), exposedAt = new Date(Date.now() + 1000);
  await writeFile(exposureFile, JSON.stringify({ cwd: project, timestamp: exposedAt.toISOString() }) + '\n');
  // Explicitly post-migration, independent of the filesystem's same-tick mtime granularity.
  await utimes(exposureFile, exposedAt, exposedAt);
  const store = join(root, 'store.json');
  const ruleIdentity = `project:${join(project, '.claude/rules-on-demand')}:sample.md`;
  await writeFile(store, JSON.stringify({ 'compliance-verdicts-jsonl': Array.from({ length: 5 }, () => JSON.stringify({ rule: 'sample.md', ruleIdentity, verdict: 'not followed', decidedAt: new Date().toISOString() })).join('\n') }));
  const verdictFile = join(root, 'verdicts.jsonl');
  const rulesDir = join(project, '.claude/rules-on-demand');
  const row = (phase, verdict, at, line) => JSON.stringify({ rule: 'sample.md', scope: 'project', rulesDir, phase, verdict, checkVerdict: verdict === 'static baseline' ? 'followed' : undefined, at, line });
  await writeFile(verdictFile, [...Array.from({ length: 5 }, (_, i) => row('before', 'static baseline', new Date(Date.now() - 259200000).toISOString(), i + 1)),
    ...Array.from({ length: 5 }, (_, i) => row('after', 'not followed', new Date(Date.now() + 1000).toISOString(), i + 10))].join('\n') + '\n');
   const result = spawnSync(process.execPath, [rollback, '--project', project, '--store', store, '--verdicts', verdictFile, '--json'], { encoding: 'utf8', env: cleanEnv({ CLAUDE_CONFIG_DIR: config, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_ROOT: fileURLToPath(new URL('..', import.meta.url)) }) });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(JSON.parse(result.stdout)[0].action, 'reverted', result.stdout);
   const digest = createHash('sha256').update(await realpath(project)).digest('hex').slice(0, 12);
   assert.equal(JSON.parse(await readFile(join(data, `quality/rollback-project-${digest}-latest.json`), 'utf8')).reverted[0].rule, 'sample.md');
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

ruleTest('daily quality check is dry-run and leaves entire project rule tree and ledger unchanged', async (t, realRule) => {
  const root = await sandbox(t, realRule);
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

ruleTest('unattributed dry-run needs attention and leaves rule and ledger byte-identical', async (t, realRule) => {
  const root = await sandbox(t, realRule);
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
  const { env } = await qualityEnvironment(root, config);
  const projects = join(config, 'projects');
  await mkdir(join(project, '.claude/rules'), { recursive: true });
  await mkdir(projects, { recursive: true });
  await writeFile(join(project, '.claude/rules/sample.md'), 'Check agent model.\n');
  await migrateRule(project, 'sample.md', { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'check', check: 'agent-model' } }, { noProofReason: 'no historical transcript', unproven: true }, { configDir: config });
  const file = join(project, '.claude/rules-on-demand/sample.md');
  const before = await readFile(file);
  const ledgerBefore = await readFile(join(project, '.claude/rules-on-demand-ledger.jsonl'));
  await writeFile(join(project, '.claude/rules-on-demand-ledger.jsonl'), Buffer.concat([ledgerBefore, Buffer.from('not-json\n')]));
  await writeFile(join(projects, 'sample.jsonl'), JSON.stringify({ type: 'assistant', cwd: project, timestamp: new Date().toISOString(), message: { content: [{ type: 'tool_use', id: 'fixture-agent', name: 'Agent', input: { model: 'sonnet' } }] } }) + '\n');
  const data = join(config, 'plugins/data/wt-rules-on-demand/quality');
   const run = spawnSync(process.execPath, [quality, '--project', project, '--config-dir', config, '--data-dir', data], { encoding: 'utf8', timeout: 60_000, env });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(await readFile(join(data, 'latest.json'), 'utf8'));
  assert.equal(report.ok, true);
  assert.deepEqual(report.rollbackNotes, [], 'quality must not read the ambient legacy store');
  assert.equal(report.coverage.malformedLedgerLines, 1);
  assert.ok(!(await readdir(data)).some((name) => name.endsWith('.tmp')));
  assert.deepEqual(report.unproven, [{ scope: 'project', rule: 'sample.md', reason: 'no historical transcript' }]);
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(join(project, '.claude/rules-on-demand-ledger.jsonl')), Buffer.concat([ledgerBefore, Buffer.from('not-json\n')]));
});

test('automatic quality pipeline reports would-revert but leaves entire rule tree untouched', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-daily-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const project = join(root, 'project');
  const config = join(root, 'config');
  const { env } = await qualityEnvironment(root, config);
  await mkdir(join(project, '.claude/rules'), { recursive: true });
  await mkdir(join(config, 'projects'), { recursive: true });
  await writeFile(join(project, '.claude/rules/sample.md'), 'Choose a model.\n');
  await migrateRule(project, 'sample.md', { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'check', check: 'agent-model', 'rollback-min-samples': 5 } }, { unproven: true }, { configDir: config });
  const file = join(project, '.claude/rules-on-demand/sample.md');
  const ledgerFile = join(project, '.claude/rules-on-demand-ledger.jsonl');
  const before = await readFile(file);
  const ledgerBefore = await readFile(ledgerFile);
  const treeBefore = await tree(join(project, '.claude'));
  const at = new Date().toISOString();
  const staticAt = new Date(Date.now() - 86400000).toISOString();
  // Static era, before the migration, in its own session: the rule was followed (a model was chosen) — the baseline.
  const staticRecords = Array.from({ length: 6 }, (_, i) => ({ type: 'assistant', cwd: project, timestamp: staticAt, message: { content: [{ type: 'tool_use', id: `static-${i}`, name: 'Agent', input: { prompt: 'work', model: 'sonnet' } }] } }));
  await writeFile(join(config, 'projects/static.jsonl'), staticRecords.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const records = [
    { type: 'attachment', cwd: project, timestamp: at, attachment: { type: 'hook_additional_context', content: '<rule name="sample.md">\nChoose a model.\n</rule>', toolUseID: 'fixture-context' } },
    ...Array.from({ length: 8 }, (_, i) => ({ type: 'assistant', cwd: project, timestamp: at, message: { content: [{ type: 'tool_use', id: `fixture-${i}`, name: 'Agent', input: { prompt: 'work' } }] } })),
  ];
  const exposureDir = join(config, 'projects', project.replace(/[^a-zA-Z0-9]/g, '-'));
  await mkdir(exposureDir, { recursive: true });
  await writeFile(join(exposureDir, 'sample.jsonl'), records.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const exposureMtime = new Date(Date.now() + 1000);
  await utimes(join(exposureDir, 'sample.jsonl'), exposureMtime, exposureMtime);
  const data = join(config, 'plugins/data/wt-rules-on-demand/quality');
   const run = spawnSync(process.execPath, [quality, '--project', project, '--config-dir', config, '--data-dir', data], { encoding: 'utf8', timeout: 60_000, env });
  assert.equal(run.status, 0, run.stderr);
  const report = JSON.parse(await readFile(join(data, 'latest.json'), 'utf8'));
  assert.deepEqual(report.rollbackNotes, [], 'quality must not read the ambient legacy store');
  assert.equal(report.rollback[0]?.action, 'would revert');
  assert.deepEqual(await readFile(file), before);
  assert.deepEqual(await readFile(ledgerFile), ledgerBefore);
  assert.deepEqual(await tree(join(project, '.claude')), treeBefore);
});

test('readSpec refuses every spec migrate would refuse: prove and apply share the full runtime parser', async (t) => {
  const root = await mkdtemp(join(tmpdir(), 'rod-readspec-parity-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const spec = { 'on-demand': { triggers: [{ kind: 'prompt', regex: 'deploy' }] }, compliance: { kind: 'model', model: 'fixture', prompt: 'p', 'on-close': 'not applicable' } };
  const path = join(root, 'spec.json');
  await writeFile(path, JSON.stringify(spec));
  await mkdir(join(root, '.claude', 'rules'), { recursive: true });
  await writeFile(join(root, '.claude', 'rules', 'sample.md'), 'Body.\n');
  // apply refuses this spec through parseRuntimeRule ...
  await assert.rejects(() => migrateRule(root, 'sample.md', { triggers: spec['on-demand'].triggers, compliance: spec.compliance }, { unproven: true }), /window must be a positive integer/);
  // ... so the reader prove uses must refuse it too, before any proof is spent on it.
  await assert.rejects(readSpec(path), /window must be a positive integer/);
});
