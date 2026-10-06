import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { assertProfiles } from '../scripts/profile-check.mjs';
import { engineId as id, enabledSettings as enabled, installFixture } from '../test-support/profile-fixture.mjs';

const guard = 'cc-plugin-sec-default@builtin';
const guardValue = (value) => ({ pluginConfigs: { [guard]: { options: { allowManagedModsOnly: value } } } });
const rows = [
  { name: 'managed-only absent user file', absentUser: true, managed: enabled, allow: true },
  { name: 'managed hooks permission supersedes user prohibition', user: { ...enabled, disableAllHooks: true }, managed: { disableAllHooks: false }, allow: true },
  { name: 'managed mods permission supersedes user prohibition', user: { ...enabled, pluginConfigs: { ...enabled.pluginConfigs, ...guardValue(true).pluginConfigs } }, managed: guardValue(false), allow: true },
  { name: 'managed function flag overrides process flag', managed: { env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0' } }, version: '2.1.286', processFlag: '1', allow: false },
  { name: 'readable old-build hook disablement', user: { ...enabled, env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0' } }, version: '2.1.286', allow: false },
  { name: 'enabled false', user: { ...enabled, pluginConfigs: { [id]: { options: { enabled: false } } } }, allow: false },
  { name: 'option absent uses disabled manifest default', user: { ...enabled, pluginConfigs: { [id]: { options: {} } } }, allow: false },
  { name: 'malformed option', user: { ...enabled, pluginConfigs: { [id]: { options: { enabled: 'true' } } } }, allow: false },
  { name: 'plugin disabled', user: { ...enabled, enabledPlugins: { [id]: false } }, allow: false },
  { name: 'effective hooks disabled', managed: { disableAllHooks: true }, allow: false },
  { name: 'effective managed mods only', managed: guardValue(true), allow: false },
  { name: 'user guard option alone is not managed policy', user: { ...enabled, pluginConfigs: { ...enabled.pluginConfigs, ...guardValue(true).pluginConfigs } }, allow: true },
  { name: 'inline-only under sideload prohibition', user: { enabledPlugins: { 'wt-rules-on-demand@inline': true }, pluginConfigs: { 'wt-rules-on-demand@inline': { options: { enabled: true } } } }, managed: { disableSideloadFlags: true }, inline: true, allow: false },
  { name: 'managed engine permission overrides user false', user: { ...enabled, pluginConfigs: { [id]: { options: { enabled: false } } } }, managed: { pluginConfigs: enabled.pluginConfigs }, allow: true },
  { name: 'managed engine false overrides user permission', managed: { pluginConfigs: { [id]: { options: { enabled: false } } } }, allow: false },
  { name: 'managed plugin permission overrides user false', user: { ...enabled, enabledPlugins: { [id]: false } }, managed: { enabledPlugins: enabled.enabledPlugins }, allow: true },
  { name: 'managed plugin false overrides user permission', managed: { enabledPlugins: { [id]: false } }, allow: false },
  { name: 'installed plus historical inline source', healthSource: 'inline', managed: { disableSideloadFlags: true }, allow: true },
  { name: 'obsolete disabled identity beside enabled source', user: { ...enabled, enabledPlugins: { ...enabled.enabledPlugins, 'wt-rules-on-demand@old': false } }, allow: true },
  { name: 'stale record before valid installation', stale: true, managed: { disableSideloadFlags: true }, allow: true },
  { name: 'missing engine presence', installed: false, allow: false },
  { name: 'invalid existing user JSON', raw: '{invalid', allow: false },
  { name: 'drop-in hooks permission supersedes managed base', managed: { disableAllHooks: true }, dropin: { disableAllHooks: false }, allow: true },
  { name: 'drop-in hooks prohibition supersedes managed base', managed: { disableAllHooks: false }, dropin: { disableAllHooks: true }, allow: false },
  { name: 'drop-in engine permission supersedes managed base', managed: { pluginConfigs: { [id]: { options: { enabled: false } } } }, dropin: { pluginConfigs: enabled.pluginConfigs }, allow: true },
  { name: 'drop-in function flag supersedes managed permission', managed: { env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '1' } }, dropin: { env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: '0' } }, version: '2.1.286', processFlag: '1', allow: false },
  { name: 'readable inline source with affirmative configuration', user: { pluginConfigs: { 'wt-rules-on-demand@inline': { options: { enabled: true } } } }, inline: true, allow: true },
  { name: 'malformed readable function flag cannot fall back to process permission', user: { ...enabled, env: { CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: null } }, version: '2.1.286', processFlag: '1', allow: false },
  { name: 'malformed readable environment cannot fall back to process permission', user: { ...enabled, env: [] }, version: '2.1.286', processFlag: '1', allow: false },
  { name: 'existing dangling user file is not absent', absentUser: true, danglingUser: true, managed: enabled, allow: false },
];

for (const row of rows) test(`effective profile policy: ${row.name}`, async (t) => {
  const root = await fs.mkdtemp(join(tmpdir(), 'rod-policy-matrix-'));
  t.after(() => fs.rm(root, { recursive: true, force: true }));
  const profile = join(root, 'profile');
  const managedFile = join(root, 'managed-settings.json');
  await fs.mkdir(profile);
  if (!row.absentUser) await fs.writeFile(join(profile, 'settings.json'), row.raw ?? JSON.stringify(row.user ?? enabled));
  if (row.danglingUser) await fs.symlink(join(root, 'missing-settings.json'), join(profile, 'settings.json'));
  await fs.writeFile(managedFile, JSON.stringify(row.managed ?? {}));
  if (row.dropin) {
    await fs.mkdir(join(root, 'managed-settings.d'));
    await fs.writeFile(join(root, 'managed-settings.d', 'policy.json'), JSON.stringify(row.dropin));
  }
  if (row.installed !== false && !row.inline) await installFixture(profile, row.stale);
  const env = { CLAUDE_CONFIG_DIR: profile, CLAUDE_CODE_EXECPATH: `/v/${row.version ?? '2.1.287'}`, CLAUDE_CODE_ENABLE_FUNCTION_HOOKS: row.processFlag ?? '0' };
  if (row.inline) {
    env.CLAUDE_PLUGIN_ROOT = join(root, 'inline');
    await fs.mkdir(join(env.CLAUDE_PLUGIN_ROOT, '.claude-plugin'), { recursive: true });
    await fs.writeFile(join(env.CLAUDE_PLUGIN_ROOT, '.claude-plugin', 'plugin.json'), '{"name":"wt-rules-on-demand"}');
  }
  for (const health of [false, true]) {
    if (health) {
      const store = join(profile, 'plugins', 'store');
      await fs.mkdir(store, { recursive: true });
      await fs.writeFile(join(store, `wt-rules-on-demand_${row.healthSource ?? 'local'}-0123456789ab.json`), JSON.stringify({ health: { days: { [new Date().toISOString().slice(0, 10)]: { calls: 1 } } } }));
    }
    for (const assumed of [[], [profile]]) {
      let outcome = 'ALLOW';
      try { await assertProfiles(profile, [], assumed, env, { managedFile, warn: () => {} }); }
      catch (error) { outcome = 'REFUSE'; if (row.raw) assert.ok(error.message.includes(join(profile, 'settings.json')), error.message); }
      assert.equal(outcome, row.allow ? 'ALLOW' : 'REFUSE', `${row.name}: health=${health}, assumed=${assumed.length > 0}`);
    }
  }
});
