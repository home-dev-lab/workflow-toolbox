import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { cleanEnv, managedPolicyArgs } from './clean-env.mjs';
import { migrateRule, readSpec } from '../scripts/rule-lifecycle-lib.mjs';
import { managedSettingsPath, assertProfiles } from '../scripts/profile-check.mjs';
import { dailyRollback } from '../scripts/daily-rollback.mjs';

const cli = fileURLToPath(new URL('../scripts/rules.mjs', import.meta.url));
const id = 'wt-rules-on-demand@local';
const enabled = { enabledPlugins: { [id]: true }, pluginConfigs: { [id]: { options: { enabled: true } } } };
const body = 'Keep this rule.\n';
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'rod-profile-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const primary = join(root, 'primary');
  const managed = join(root, 'managed.json');
  await mkdir(join(primary, 'rules'), { recursive: true });
  await writeFile(join(primary, 'rules', 'sample.md'), body);
  await writeFile(join(primary, 'settings.json'), JSON.stringify(enabled));
  const spec = join(root, 'spec.json');
  await writeFile(spec, JSON.stringify({ 'on-demand': { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }] }, compliance: { kind: 'none', reason: 'fixture' } }));
  const run = (...args) => spawnSync(process.execPath, [...managedPolicyArgs, cli, 'migrate', 'sample.md', '--user', '--config-dir', primary, '--spec', spec, '--no-proof', 'fixture', ...args],
    { encoding: 'utf8', env: cleanEnv({ WT_ROD_TEST_MANAGED_SETTINGS: managed, CLAUDE_CONFIG_DIR: primary, CLAUDE_CODE_EXECPATH: '/opt/claude/versions/2.1.287' }) });
  const intact = async () => {
    assert.equal(await readFile(join(primary, 'rules', 'sample.md'), 'utf8'), body);
    assert.equal(await readFile(join(primary, 'rules-on-demand-ledger.jsonl'), 'utf8').catch(() => null), null);
    assert.deepEqual(await readdir(join(primary, 'rules-on-demand')).catch(() => []), []);
  };
  return { root, primary, managed, spec, run, intact };
}

for (const [key, policy] of [
  ['disableAllHooks', { disableAllHooks: true }],
  ['allowManagedModsOnly', { pluginConfigs: { 'cc-plugin-sec-default@builtin': { options: { allowManagedModsOnly: true } } } }],
  ['allowManagedHooksOnly', { allowManagedHooksOnly: true }],
  ['enabledPlugins', { enabledPlugins: { [id]: false } }],
  ['options.enabled', { pluginConfigs: { [id]: { options: { enabled: false } } } }],
]) test(`managed ${key} refuses migration despite recent activity and assume-loaded`, async (t) => {
  const p = await fixture(t);
  const store = join(p.primary, 'plugins', 'store');
  await mkdir(store, { recursive: true });
  await writeFile(join(store, 'wt-rules-on-demand_inline-0123456789ab.json'), JSON.stringify({ health: { days: { [new Date().toISOString().slice(0, 10)]: { calls: 1 } } } }));
  await writeFile(p.managed, JSON.stringify(policy));
  for (const args of [[], ['--assume-loaded', p.primary]]) {
    const run = p.run(...args);
    assert.notEqual(run.status, 0, `managed ${key} must refuse before moving the static rule`);
    assert.ok(run.stderr.includes(managedSettingsPath()), run.stderr);
    assert.ok(run.stderr.includes(key), run.stderr);
    assert.match(run.stderr, /--settings.*--safe-mode.*--bare.*--setting-sources/);
    await p.intact();
  }
});

test('invalid or unreadable managed settings refuse by filename; absent and empty are normal', async (t) => {
  const p = await fixture(t);
  await writeFile(p.managed, '{invalid');
  const invalid = p.run();
  assert.notEqual(invalid.status, 0, 'invalid managed settings must refuse');
  assert.ok(invalid.stderr.includes(managedSettingsPath()), invalid.stderr);
  await p.intact();
  await rm(p.managed);
  await mkdir(p.managed);
  const unreadable = p.run();
  assert.notEqual(unreadable.status, 0, 'unreadable managed settings must refuse');
  assert.ok(unreadable.stderr.includes(managedSettingsPath()), unreadable.stderr);
  await p.intact();
  await rm(p.managed, { recursive: true });
  assert.equal(p.run().status, 0);
});

test('non-object managed settings refuse rather than being treated as empty', async (t) => {
  const p = await fixture(t);
  for (const value of ['null', '[]', 'true']) {
    await writeFile(p.managed, value);
    const run = p.run();
    assert.notEqual(run.status, 0, `managed ${value} must refuse`);
    assert.ok(run.stderr.includes(managedSettingsPath()), run.stderr);
    await p.intact();
  }
  await writeFile(p.managed, '{}');
  assert.equal(p.run().status, 0);
});

for (const source of ['user', 'managed']) test(`top-level allowManagedModsOnly in ${source} settings does not prohibit migration`, async (t) => {
  const p = await fixture(t);
  const store = join(p.primary, 'plugins', 'store');
  await mkdir(store, { recursive: true });
  await writeFile(join(store, 'wt-rules-on-demand_inline-0123456789ab.json'), JSON.stringify({ health: { days: { [new Date().toISOString().slice(0, 10)]: { calls: 1 } } } }));
  if (source === 'user') await writeFile(join(p.primary, 'settings.json'), JSON.stringify({ ...enabled, allowManagedModsOnly: true }));
  else await writeFile(p.managed, JSON.stringify({ allowManagedModsOnly: true }));
  const run = p.run();
  assert.equal(run.status, 0, 'top-level allowManagedModsOnly must not refuse');
  assert.match(await readFile(join(p.primary, 'rules-on-demand', 'sample.md'), 'utf8'), /Keep this rule/);
});

test('shared static rules with separate on-demand storage refuse without changing either profile', async (t) => {
  const p = await fixture(t);
  const mirror = join(p.root, 'mirror');
  await mkdir(join(mirror, 'rules-on-demand'), { recursive: true });
  await writeFile(join(mirror, 'rules-on-demand', 'owned.md'), 'Owned mirror content.\n');
  await symlink(join(p.primary, 'rules'), join(mirror, 'rules'), 'junction');
  await assert.rejects(migrateRule(p.primary, 'sample.md', await readSpec(p.spec), { unproven: true }, { scope: 'user', mirrorDirs: [mirror] }),
    /shared rules.*separate rules-on-demand/);
  await p.intact();
  assert.equal(await readFile(join(mirror, 'rules', 'sample.md'), 'utf8'), body);
  assert.equal(await readFile(join(mirror, 'rules-on-demand', 'owned.md'), 'utf8'), 'Owned mirror content.\n');
});

test('repeated mirror-dir and assume-loaded preserve comma-containing profile names through migrate and revert', async (t) => {
  const p = await fixture(t);
  const mirrors = [join(p.root, 'team,blue'), join(p.root, 'other')];
  for (const mirror of mirrors) {
    await mkdir(join(mirror, 'rules'), { recursive: true });
    await symlink(join(p.primary, 'rules', 'sample.md'), join(mirror, 'rules', 'sample.md'));
  }
  const flags = mirrors.flatMap((mirror) => ['--mirror-dir', mirror]);
  const run = p.run(...flags, ...mirrors.flatMap((mirror) => ['--assume-loaded', mirror]));
  assert.equal(run.status, 0, run.stderr);
  for (const mirror of mirrors) assert.notEqual(await readFile(join(mirror, 'rules-on-demand', 'sample.md'), 'utf8').catch(() => null), null,
    'the literal comma-containing mirror must receive the migrated rule');
  const reverted = spawnSync(process.execPath, [cli, 'revert', 'sample.md', '--user', '--config-dir', p.primary, ...flags], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(reverted.status, 0, reverted.stderr);
  for (const mirror of mirrors) assert.equal(await readFile(join(mirror, 'rules', 'sample.md'), 'utf8'), body);
});

test('mirror launch version is unknown without profile evidence, regardless of migrating build', async (t) => {
  const p = await fixture(t);
  const mirror = join(p.root, 'mirror');
  await mkdir(mirror);
  await writeFile(join(mirror, 'settings.json'), JSON.stringify(enabled));
  const run = p.run('--mirror-dir', mirror);
  assert.notEqual(run.status, 0, 'the primary process version must not prove the mirror launch version');
  assert.match(run.stderr, /mirror.*version unknown/);
  await p.intact();
  await writeFile(join(mirror, 'settings.json'), JSON.stringify({ ...enabled, env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } }));
  assert.equal(p.run('--mirror-dir', mirror).status, 0);
});

test('platform policy paths are explicit; an unsupported platform is a named refusal', () => {
  assert.equal(managedSettingsPath('linux'), '/etc/claude-code/managed-settings.json');
  assert.equal(managedSettingsPath('darwin'), '/Library/Application Support/ClaudeCode/managed-settings.json');
  assert.equal(managedSettingsPath('win32'), 'C:\\Program Files\\ClaudeCode\\managed-settings.json');
  assert.throws(() => managedSettingsPath('other'), /location unknown on platform other/);
});

test('a mirror ignores the migrating process Function Hooks variable but accepts its own recent activity', async (t) => {
  const p = await fixture(t);
  const mirror = join(p.root, 'mirror');
  await mkdir(join(mirror, 'plugins', 'store'), { recursive: true });
  await writeFile(join(mirror, 'settings.json'), JSON.stringify(enabled));
  const env = cleanEnv({ CLAUDE_CONFIG_DIR: p.primary, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' });
  const io = { managedFile: p.managed };
  await assert.rejects(assertProfiles(p.primary, [mirror], [], env, io), /mirror.*launch version unknown/);
  await writeFile(join(mirror, 'plugins', 'store', 'wt-rules-on-demand_inline-0123456789ab.json'), JSON.stringify({ health: { days: { [new Date().toISOString().slice(0, 10)]: { calls: 1 } } } }));
  await assertProfiles(p.primary, [mirror], [], env, io);
});

test('shared static and shared resolved on-demand directories still migrate and revert', async (t) => {
  const p = await fixture(t);
  const mirror = join(p.root, 'mirror');
  await mkdir(mirror);
  await mkdir(join(p.primary, 'rules-on-demand'));
  for (const dir of ['rules', 'rules-on-demand']) await symlink(join(p.primary, dir), join(mirror, dir), 'junction');
  assert.equal(p.run('--mirror-dir', mirror, '--assume-loaded', mirror).status, 0);
  assert.match(await readFile(join(mirror, 'rules-on-demand', 'sample.md'), 'utf8'), /Keep this rule/);
  const reverted = spawnSync(process.execPath, [cli, 'revert', 'sample.md', '--user', '--config-dir', p.primary, '--mirror-dir', mirror], { encoding: 'utf8', env: cleanEnv() });
  assert.equal(reverted.status, 0, reverted.stderr);
  assert.equal(await readFile(join(mirror, 'rules', 'sample.md'), 'utf8'), body);
});

test('a shared-static mirror with absent on-demand storage is refused before creating storage', async (t) => {
  const p = await fixture(t);
  const mirror = join(p.root, 'mirror');
  await mkdir(mirror);
  await symlink(join(p.primary, 'rules'), join(mirror, 'rules'), 'junction');
  const run = p.run('--mirror-dir', mirror, '--assume-loaded', mirror);
  assert.notEqual(run.status, 0);
  assert.match(run.stderr, /shared rules.*separate rules-on-demand/);
  await p.intact();
  assert.deepEqual(await readdir(mirror), ['rules']);
});

test('daily applied rollback forwards repeated literal mirror paths and restores every mirror', async (t) => {
  const p = await fixture(t);
  const mirrors = [join(p.root, 'team,blue'), join(p.root, 'other')];
  for (const mirror of mirrors) {
    await mkdir(join(mirror, 'rules'), { recursive: true });
    await symlink(join(p.primary, 'rules', 'sample.md'), join(mirror, 'rules', 'sample.md'));
  }
  await migrateRule(p.primary, 'sample.md', { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }], compliance: { kind: 'check', check: 'agent-model' } },
    { unproven: true }, { scope: 'user', mirrorDirs: mirrors });
  const rulesDir = join(p.primary, 'rules-on-demand');
  const verdictPath = join(p.root, 'verdicts.jsonl');
  const before = new Date(Date.now() - 86400000).toISOString();
  const after = new Date(Date.now() + 1000).toISOString();
  const rows = Array.from({ length: 10 }, (_, line) => [
    { rule: 'sample.md', scope: 'user', rulesDir, phase: 'before', checkVerdict: 'followed', at: before, line },
    { rule: 'sample.md', scope: 'user', rulesDir, verdict: 'not followed', at: after, line: line + 10 },
  ]).flat();
  await writeFile(verdictPath, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
  const outcome = await dailyRollback({ configDirs: [p.primary], mirrorDirs: mirrors, apply: true,
    checkQuality: async () => ({ complete: true, coverage: {}, scan: {}, verdictPath, scopes: [{ scope: 'user', rulesDir }] }) });
  assert.equal(outcome.code, 0, JSON.stringify(outcome.result));
  assert.equal(outcome.result.reverted.length, 1, JSON.stringify(outcome.result));
  for (const mirror of mirrors) assert.equal(await readFile(join(mirror, 'rules', 'sample.md'), 'utf8').catch(() => null), body,
    'daily rollback must restore each literal mirror path');
});
