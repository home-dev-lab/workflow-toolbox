import { readFile, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { claudeVersion, modsOnByDefault } from './claude-version.mjs';
import { ACTIVITY_DAYS, recentActivity } from './engine-activity.mjs';
import { configDirectory } from '../paths.js';
import { managedPolicies, objectSettings, refuse } from './managed-policy.mjs';
export { managedSettingsPath } from './managed-policy.mjs';

const isEngine = (name) => name.startsWith('wt-rules-on-demand@');

function assertNoContradiction(settings, source) {
  if (settings.disableAllHooks === true) refuse(`${source}: hooks disabled (disableAllHooks); no rule would be served`);
  const off = Object.entries(settings.pluginConfigs ?? {}).find(([name, value]) => isEngine(name) && value?.options?.enabled === false);
  if (off) refuse(`${source}: engine switched off (pluginConfigs["${off[0]}"].options.enabled is false)`);
}

function assertManagedPolicy(settings, source) {
  assertNoContradiction(settings, source);
  if (settings.pluginConfigs?.['cc-plugin-sec-default@builtin']?.options?.allowManagedModsOnly === true)
    refuse(`${source}: pluginConfigs["cc-plugin-sec-default@builtin"].options.allowManagedModsOnly forbids a user-installed engine; organization-managed deployment cannot be established from local evidence`);
  if (settings.allowManagedHooksOnly === true)
    refuse(`${source}: allowManagedHooksOnly forbids a user-installed engine; organization-managed deployment cannot be established from local evidence`);
  const off = Object.entries(settings.enabledPlugins ?? {}).find(([name, value]) => isEngine(name) && value === false);
  if (off) refuse(`${source}: enabledPlugins["${off[0]}"] is false`);
}

async function resolvedProfile(dir) {
  if (!dir) return null;
  try { return await realpath(dir); } catch { return null; }
}

async function assertProfile(dir, runningProfile, env) {
  let settings;
  try { settings = JSON.parse(await readFile(join(dir, 'settings.json'), 'utf8')); }
  catch { refuse(`profile ${dir}: settings.json missing or invalid; use --assume-loaded ${dir} only with explicit verification`); }
  if (!objectSettings(settings)) refuse(`profile ${dir}: settings.json must contain a settings object`);
  assertNoContradiction(settings, `profile ${dir}`);
  const plugins = Object.entries(settings.enabledPlugins ?? {}).filter(([name]) => isEngine(name));
  const disabled = new Set(plugins.filter(([, on]) => on === false).map(([name]) => name.slice(name.indexOf('@') + 1)));
  const active = await recentActivity(dir, disabled);
  if (active) { console.error(`rules: profile ${dir}: engine active on ${active.day} (${active.store})`); return; }
  const listed = plugins.filter(([, on]) => on === true).map(([name]) => name);
  if (!listed.length) refuse(`profile ${dir}: plugin not enabled in settings.json and no engine health day in the last ${ACTIVITY_DAYS} days in plugins/store; use --assume-loaded ${dir} only with explicit verification`);
  if (!listed.some((name) => settings.pluginConfigs?.[name]?.options?.enabled === true)) refuse(`profile ${dir}: engine not enabled (pluginConfigs["${listed[0]}"].options.enabled is not true); use --assume-loaded ${dir} only with explicit verification`);
  // The migrating process cannot prove which build or environment launches another profile.
  const primary = runningProfile !== null && await resolvedProfile(dir) === runningProfile;
  const version = primary ? claudeVersion(env)?.version ?? null : null;
  if (modsOnByDefault(version)) return;
  if (settings.env?.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === '1' || primary && env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS === '1') return;
  const mirrorLimit = primary ? '' : ' (mirror or foreign profile launch version unknown; the migrating process version/environment does not establish it)';
  refuse(`profile ${dir}: Function Hooks not known to be on: Claude Code ${version ?? 'version unknown'}${mirrorLimit}; 2.1.287 and later load mods by default, older builds may need CLAUDE_CODE_ENABLE_FUNCTION_HOOKS=1; verify, then pass --assume-loaded ${dir}`);
}

export async function assertProfiles(configDir, mirrorDirs, assumed, env = process.env, options = {}) {
  const policies = await managedPolicies(options);
  // Known managed contradictions are not bypassed by assumptions or earlier engine activity.
  // Conflicting fragments are conservative: any readable prohibition wins.
  for (const managed of policies) assertManagedPolicy(managed.settings, `managed settings ${managed.file}`);
  const runningProfile = await resolvedProfile(configDirectory(env));
  for (const dir of [configDir, ...mirrorDirs]) {
    if (!assumed.includes(dir)) await assertProfile(dir, runningProfile, env);
  }
}
