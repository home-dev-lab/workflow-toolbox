import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cleanEnv, managedPolicyArgs } from './clean-env.mjs';
import { managedSettingsPath } from '../scripts/profile-check.mjs';
import { installFixture } from '../test-support/profile-fixture.mjs';

const cli = fileURLToPath(new URL('../scripts/rules.mjs', import.meta.url));
const id = 'wt-rules-on-demand@local';
const guard = 'cc-plugin-sec-default@builtin';
const enabled = { enabledPlugins: { [id]: true }, pluginConfigs: { [id]: { options: { enabled: true } } } };
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'rod-policy-r3-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  const managed = join(root, 'managed-settings.json');
  const spec = join(root, 'spec.json');
  await fs.mkdir(join(profile, 'rules'), { recursive: true });
  await installFixture(profile);
  await fs.writeFile(join(profile, 'rules', 'sample.md'), 'Keep this rule.\n');
  await fs.writeFile(spec, JSON.stringify({ 'on-demand': { triggers: [{ kind: 'tool', tool: '^Agent$', unconditional: true }] }, compliance: { kind: 'none', reason: 'fixture' } }));
  const settings = (value) => fs.writeFile(join(profile, 'settings.json'), JSON.stringify(value));
  await settings(enabled);
  const args = [cli, 'migrate', 'sample.md', '--user', '--config-dir', profile, '--spec', spec, '--no-proof', 'fixture'];
  const env = cleanEnv({ WT_ROD_TEST_MANAGED_SETTINGS: managed, CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_EXECPATH: '/v/2.1.287' });
  const run = (...extra) => spawnSync(process.execPath, [...managedPolicyArgs, ...args, ...extra], { encoding: 'utf8', env });
  const intact = async () => {
    assert.equal(await fs.readFile(join(profile, 'rules', 'sample.md'), 'utf8'), 'Keep this rule.\n');
    assert.equal(await fs.readFile(join(profile, 'rules-on-demand-ledger.jsonl'), 'utf8').catch(() => null), null);
    assert.deepEqual(await fs.readdir(join(profile, 'rules-on-demand')).catch(() => []), []);
  };
  const health = async (source) => {
    const store = join(profile, 'plugins', 'store');
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(join(store, `wt-rules-on-demand_${source}-0123456789ab.json`), JSON.stringify({ health: { days: { [new Date().toISOString().slice(0, 10)]: { calls: 1 } } } }));
  };
  return { root, profile, managed, settings, run, intact, health, args, env };
}

for (const location of ['base', 'drop-in']) test(`disableSideloadFlags in ${location} refuses inline evidence without changing state`, async (t) => {
  const p = await fixture(t);
  await p.settings({});
  await p.health('inline');
  const file = location === 'base' ? p.managed : join(p.root, 'managed-settings.d', 'sideload.json');
  await fs.mkdir(dirname(file), { recursive: true });
  await fs.writeFile(file, '{"disableSideloadFlags":true}');
  for (const extra of [[], ['--assume-loaded', p.profile]]) {
    const run = p.run(...extra);
    assert.notEqual(run.status, 0, 'disableSideloadFlags must refuse inline evidence');
    assert.match(run.stderr, /disableSideloadFlags/);
    const source = location === 'base' ? managedSettingsPath() : join(dirname(managedSettingsPath()), 'managed-settings.d', 'sideload.json');
    assert.ok(run.stderr.includes(source), run.stderr);
    await p.intact();
  }
});

test('disableSideloadFlags refuses unknown plugin source even with assume-loaded', async (t) => {
  const p = await fixture(t);
  await fs.rm(join(p.profile, 'plugins', 'installed_plugins.json'));
  await fs.writeFile(p.managed, '{"disableSideloadFlags":true}');
  const run = p.run('--assume-loaded', p.profile);
  assert.notEqual(run.status, 0, 'disableSideloadFlags must refuse unknown source');
  assert.match(run.stderr, /disableSideloadFlags.*source.*established/);
  await p.intact();
});

test('disableSideloadFlags permits installed cached plugin evidence', async (t) => {
  const p = await fixture(t);
  await fs.writeFile(p.managed, '{"disableSideloadFlags":true}');
  await p.health('local');
  const run = p.run();
  assert.equal(run.status, 0, run.stderr);
  assert.match(await fs.readFile(join(p.profile, 'rules-on-demand', 'sample.md'), 'utf8'), /Keep this rule/);
});

for (const [key, value] of [
  ['disableAllHooks', { ...enabled, disableAllHooks: true }],
  ['enabledPlugins', { ...enabled, enabledPlugins: { [id]: false } }],
  ['options.enabled', { ...enabled, pluginConfigs: { [id]: { options: { enabled: false } } } }],
]) test(`assume-loaded never waives user ${key} contradiction`, async (t) => {
  const p = await fixture(t);
  await p.health('inline');
  await p.settings(value);
  for (const extra of [['--assume-loaded', p.profile], []]) {
    const run = p.run(...extra);
    assert.notEqual(run.status, 0, `assume-loaded must not waive ${key}`);
    assert.ok(run.stderr.includes(key), run.stderr);
    await p.intact();
  }
});

test('assume-loaded never waives unknown version or missing affirmative enablement', async (t) => {
  for (const value of [null, {}, { enabledPlugins: enabled.enabledPlugins }, enabled]) {
    const p = await fixture(t);
    if (value === null) await fs.rm(join(p.profile, 'settings.json'));
    else await p.settings(value);
    p.env.CLAUDE_CODE_EXECPATH = '';
    const run = p.run('--assume-loaded', p.profile);
    if (value === enabled) { assert.notEqual(run.status, 0); assert.match(run.stderr, /Function Hooks not known/); }
    else {
      assert.notEqual(run.status, 0, 'assumption cannot replace affirmative enablement');
      assert.match(run.stderr, /engine not enabled/);
      await p.intact();
    }
  }
});

for (const [key, policy, type] of [
  ['disableAllHooks', { disableAllHooks: 'true' }, 'string'],
  ['allowManagedHooksOnly', { allowManagedHooksOnly: 1 }, 'number'],
  ['disableSideloadFlags', { disableSideloadFlags: null }, 'null'],
  ['enabledPlugins', { enabledPlugins: [] }, 'array'],
  [`enabledPlugins["${id}"]`, { enabledPlugins: { [id]: 'false' } }, 'string'],
  ['pluginConfigs', { pluginConfigs: [] }, 'array'],
  [`pluginConfigs["${guard}"]`, { pluginConfigs: { [guard]: 'guard' } }, 'string'],
  [`pluginConfigs["${guard}"].options`, { pluginConfigs: { [guard]: { options: 'options' } } }, 'string'],
  [`pluginConfigs["${guard}"].options.allowManagedModsOnly`, { pluginConfigs: { [guard]: { options: { allowManagedModsOnly: 'true' } } } }, 'string'],
  [`pluginConfigs["${id}"].options.enabled`, { pluginConfigs: { [id]: { options: { enabled: 'false' } } } }, 'string'],
]) test(`managed wrong type at ${key} refuses by file, path and type`, async (t) => {
  const p = await fixture(t);
  await fs.writeFile(p.managed, JSON.stringify(policy));
  const run = p.run('--assume-loaded', p.profile);
  assert.notEqual(run.status, 0, `wrong type at ${key} must refuse`);
  for (const part of [managedSettingsPath(), key, type]) assert.ok(run.stderr.includes(part), run.stderr);
  await p.intact();
});

test('NODE_OPTIONS preload plus fixture variable cannot redirect ordinary migration policy', async (t) => {
  const p = await fixture(t);
  await fs.writeFile(p.managed, '{}');
  // Simulate a readable production prohibition without accessing host policy.
  const file = managedSettingsPath();
  const mock = `import fs from 'node:fs/promises';import {syncBuiltinESMExports} from 'node:module';
    const read=fs.readFile;fs.readFile=(p,...a)=>p===${JSON.stringify(file)}?Promise.resolve('{"disableAllHooks":true}'):read(p,...a);
    const list=fs.readdir;fs.readdir=(p,...a)=>p===${JSON.stringify(join(dirname(file), 'managed-settings.d'))}?Promise.resolve([]):list(p,...a);
    syncBuiltinESMExports();`;
  const preload = fileURLToPath(new URL('../test-support/managed-policy-fixture.mjs', import.meta.url));
  const run = spawnSync(process.execPath, p.args, { encoding: 'utf8', env: { ...p.env,
    NODE_OPTIONS: `--import=data:text/javascript,${encodeURIComponent(mock)} --import=${pathToFileURL(preload).href}`,
  } });
  assert.notEqual(run.status, 0, 'ordinary NODE_OPTIONS preload must not bypass production policy');
  assert.match(run.stderr, /disableAllHooks/);
  assert.ok(run.stderr.includes(file), run.stderr);
  await p.intact();
});
