import { readFile, realpath, lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeVersion, modsOnByDefault } from './claude-version.mjs';
import { configDirectory } from '../paths.js';
import { managedPolicies, objectSettings, refuse } from './managed-policy.mjs';
import { assertPolicyTypes } from './policy-types.mjs';
import { installedEngine } from './installed-engine.mjs';
import { profileEnablement } from './profile-enablement.mjs';
export { managedSettingsPath } from './managed-policy.mjs';

const isEngine = (name) => name.startsWith('wt-rules-on-demand@');

function assertHookPolicy(effective, source) {
  if (effective.disableAllHooks === true) refuse(`${source}: hooks disabled (disableAllHooks); no rule would be served`);
  if (effective.allowManagedModsOnly === true)
    refuse(`${source}: pluginConfigs["cc-plugin-sec-default@builtin"].options.allowManagedModsOnly forbids a user-installed engine; organization-managed deployment cannot be established from local evidence`);
  if (effective.allowManagedHooksOnly === true)
    refuse(`${source}: allowManagedHooksOnly forbids a user-installed engine; organization-managed deployment cannot be established from local evidence`);
}

function assertAffirmative(effective, dir) {
  if (effective.affirmative.length) return;
  const off = Object.entries(effective.options).find(([name, value]) => isEngine(name) && value.enabled === false);
  if (off) refuse(`profile ${dir}: engine switched off (pluginConfigs["${off[0]}"].options.enabled is false)`);
  const disabled = Object.entries(effective.enabledPlugins).find(([name, on]) => isEngine(name) && on === false);
  if (disabled) refuse(`profile ${dir}: plugin not enabled in settings.json (enabledPlugins["${disabled[0]}"] is false)`);
  const id = Object.keys(effective.enabledPlugins).find(isEngine) ?? 'wt-rules-on-demand@<source>';
  refuse(`profile ${dir}: engine not enabled (pluginConfigs["${id}"].options.enabled is not true); readable user/managed settings must affirmatively enable the engine; --assume-loaded cannot replace enablement`);
}

async function resolvedProfile(dir) {
  if (!dir) return null;
  try { return await realpath(dir); } catch { return null; }
}

async function userSettings(dir) {
  const file = join(dir, 'settings.json');
  try { return JSON.parse(await readFile(file, 'utf8')); }
  catch (error) {
    if (error.code === 'ENOENT') {
      try { await lstat(file); }
      catch (inspection) {
        if (inspection.code === 'ENOENT') return {};
        refuse(`profile ${dir}: ${file} cannot be inspected (${inspection.code ?? inspection.message})`);
      }
    }
    refuse(`profile ${dir}: ${file} invalid or unreadable (${error.code ?? error.message})`);
  }
}

async function assertProfile(dir, runningProfile, env, policies) {
  const settings = await userSettings(dir);
  if (!objectSettings(settings)) refuse(`profile ${dir}: ${join(dir, 'settings.json')} must contain a settings object`);
  assertPolicyTypes(settings, `profile ${dir}: ${join(dir, 'settings.json')}`);
  const effective = profileEnablement(settings, policies);
  const listed = effective.listed;
  const source = `profile ${dir}; readable managed settings ${policies.map(({ file }) => file).join(', ')}`;
  assertHookPolicy(effective, source);
  const installed = await installedEngine(dir, listed);
  if (effective.disableSideloadFlags === true && !installed)
    refuse(`${source}: disableSideloadFlags prohibits --plugin-dir; installed engine source cannot be established`);
  assertAffirmative(effective, `${dir}; readable managed settings ${policies.map(({ file }) => file).join(', ')}`);
  // The migrating process cannot prove which build or environment launches another profile.
  const primary = runningProfile !== null && await resolvedProfile(dir) === runningProfile;
  const inline = primary && effective.affirmative.includes('wt-rules-on-demand@inline') && await inlineEngine(env.CLAUDE_PLUGIN_ROOT);
  if (!listed.length && !inline) refuse(`profile ${dir}: plugin not enabled in settings.json or readable managed settings; inline source cannot be established`);
  if (!installed && !inline) refuse(`profile ${dir}: installed or inline engine source cannot be established`);
  const version = primary ? claudeVersion(env)?.version ?? null : null;
  if (modsOnByDefault(version)) return;
  const flag = effective.env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS ?? (primary ? env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS : undefined);
  if (flag === '1') return;
  const mirrorLimit = primary ? '' : ' (mirror or foreign profile launch version unknown; the migrating process version/environment does not establish it)';
  refuse(`profile ${dir}: Function Hooks not known to be on: Claude Code ${version ?? 'version unknown'}${mirrorLimit}; 2.1.287 and later load mods by default, older builds may need CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1; --assume-loaded does not bypass readable configuration or unknown loading`);
}

async function inlineEngine(root) {
  if (!root) return false;
  try { return JSON.parse(await readFile(join(root, '.claude-plugin', 'plugin.json'), 'utf8')).name === 'wt-rules-on-demand'; }
  catch { return false; }
}

export async function assertProfiles(configDir, mirrorDirs, _assumed, env = process.env, options = {}) {
  const policies = await managedPolicies(options);
  for (const managed of policies) assertPolicyTypes(managed.settings, `managed settings ${managed.file}`);
  const runningProfile = await resolvedProfile(configDirectory(env));
  for (const dir of [configDir, ...mirrorDirs]) {
    await assertProfile(dir, runningProfile, env, policies);
  }
}
