import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { cleanEnv, managedPolicyArgs } from './clean-env.mjs';
import { installFixture } from '../test-support/profile-fixture.mjs';

const id = 'wt-rules-on-demand@local';
const enabled = { enabledPlugins: { [id]: true }, pluginConfigs: { [id]: { options: { enabled: true } } } };
async function fixture(t) {
  const root = await fs.mkdtemp(join(tmpdir(), 'rod-policy-current-'));
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
  await fs.writeFile(managed, '{}');
  const run = (assumed = false) => spawnSync(process.execPath, [...managedPolicyArgs,
    fileURLToPath(new URL('../scripts/rules.mjs', import.meta.url)), 'migrate', 'sample.md', '--user', '--config-dir', profile,
    '--spec', spec, '--no-proof', 'fixture', ...(assumed ? ['--assume-loaded', profile] : [])],
  { encoding: 'utf8', env: cleanEnv({ WT_ROD_TEST_MANAGED_SETTINGS: managed, CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_EXECPATH: '/v/2.1.287' }) });
  const health = async (source = 'local') => {
    const store = join(profile, 'plugins', 'store');
    await fs.mkdir(store, { recursive: true });
    await fs.writeFile(join(store, `wt-rules-on-demand_${source}-0123456789ab.json`), JSON.stringify({ health: { days: { [new Date().toISOString().slice(0, 10)]: { calls: 1 } } } }));
  };
  const installed = (stale = false) => installFixture(profile, stale);
  const intact = async () => {
    assert.equal(await fs.readFile(join(profile, 'rules', 'sample.md'), 'utf8'), 'Keep this rule.\n');
    assert.equal(await fs.readFile(join(profile, 'rules-on-demand-ledger.jsonl'), 'utf8').catch(() => null), null);
    assert.deepEqual(await fs.readdir(join(profile, 'rules-on-demand')).catch(() => []), []);
  };
  const migrated = async (result) => {
    assert.equal(result.status, 0, result.stderr);
    assert.match(await fs.readFile(join(profile, 'rules-on-demand', 'sample.md'), 'utf8'), /Keep this rule/);
  };
  return { profile, managed, settings, run, health, installed, intact, migrated };
}

for (const assumed of [false, true]) test(`historical health never replaces affirmative enablement${assumed ? ' with assumption' : ''}`, async (t) => {
  const p = await fixture(t);
  await p.settings({ ...enabled, pluginConfigs: { [id]: { options: {} } } });
  await p.health();
  const run = p.run(assumed);
  assert.notEqual(run.status, 0, 'historical health must not authorize a default-disabled engine');
  assert.match(run.stderr, /engine not enabled.*options.enabled.*not true/);
  await p.intact();
});

for (const value of ['false', null, 1, []]) test(`malformed user enablement ${JSON.stringify(value)} refuses before health and assumptions`, async (t) => {
  const p = await fixture(t);
  await p.settings({ ...enabled, pluginConfigs: { [id]: { options: { enabled: value } } } });
  await p.health();
  for (const assumed of [false, true]) {
    const run = p.run(assumed);
    assert.notEqual(run.status, 0, 'malformed user enablement must refuse');
    assert.ok(run.stderr.includes(`pluginConfigs["${id}"].options.enabled: expected boolean`), run.stderr);
    assert.ok(run.stderr.includes(join(p.profile, 'settings.json')), run.stderr);
    await p.intact();
  }
});

test('current installed source survives historical inline activity under sideload prohibition', async (t) => {
  const p = await fixture(t);
  await fs.writeFile(p.managed, '{"disableSideloadFlags":true}');
  await p.installed();
  await p.health('inline');
  await p.migrated(p.run());
});

test('managed affirmative enablement permits first migration without user enablement or health', async (t) => {
  const p = await fixture(t);
  await p.settings({});
  await fs.writeFile(p.managed, JSON.stringify(enabled));
  await p.installed();
  await p.migrated(p.run());
});

test('disabled obsolete identity does not veto an enabled replacement', async (t) => {
  const p = await fixture(t);
  await p.settings({ ...enabled, enabledPlugins: { ...enabled.enabledPlugins, 'wt-rules-on-demand@old': false },
    pluginConfigs: { ...enabled.pluginConfigs, 'wt-rules-on-demand@old': { options: { enabled: false } } } });
  await p.migrated(p.run());
});

test('stale installation record does not hide a later valid record', async (t) => {
  const p = await fixture(t);
  await fs.writeFile(p.managed, '{"disableSideloadFlags":true}');
  await p.installed(true);
  await p.migrated(p.run());
});

test('managed option overrides user default for the same identity', async (t) => {
  const p = await fixture(t);
  await p.settings({ ...enabled, pluginConfigs: { [id]: { options: { enabled: false, other: true } } } });
  await fs.writeFile(p.managed, JSON.stringify({ pluginConfigs: enabled.pluginConfigs }));
  await p.migrated(p.run());
});

test('affirmative option for a different identity cannot authorize historical inline health', async (t) => {
  const p = await fixture(t);
  await p.settings({ pluginConfigs: { [id]: { options: { enabled: true } } } });
  await p.health('inline');
  const run = p.run();
  assert.notEqual(run.status, 0, 'unrelated enablement must not authorize inline health');
  await p.intact();
});
