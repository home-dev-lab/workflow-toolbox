import { objectSettings, refuse } from './managed-policy.mjs';

function foundType(value) {
  if (value === null) return 'null';
  return Array.isArray(value) ? 'array' : typeof value;
}
function checkType(settings, key, type, path, source) {
  if (!Object.hasOwn(settings, key)) return;
  const value = settings[key];
  if (type === 'object' ? !objectSettings(value) : typeof value !== type)
    refuse(`${source}: ${path}: expected ${type}, found ${foundType(value)}`);
}

export function assertPolicyTypes(settings, source) {
  for (const key of ['disableAllHooks', 'allowManagedHooksOnly', 'disableSideloadFlags'])
    checkType(settings, key, 'boolean', key, source);
  for (const key of ['enabledPlugins', 'pluginConfigs', 'env']) checkType(settings, key, 'object', key, source);
  if (settings.env) checkType(settings.env, 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS', 'string', 'env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS', source);
  for (const name of Object.keys(settings.enabledPlugins ?? {})) {
    if (name.startsWith('wt-rules-on-demand@')) checkType(settings.enabledPlugins, name, 'boolean', `enabledPlugins["${name}"]`, source);
  }
  for (const [name, config] of Object.entries(settings.pluginConfigs ?? {})) {
    if (name !== 'cc-plugin-sec-default@builtin' && !name.startsWith('wt-rules-on-demand@')) continue;
    const path = `pluginConfigs["${name}"]`;
    checkType(settings.pluginConfigs, name, 'object', path, source);
    checkType(config, 'options', 'object', `${path}.options`, source);
    if (!config.options) continue;
    const key = name === 'cc-plugin-sec-default@builtin' ? 'allowManagedModsOnly' : 'enabled';
    checkType(config.options, key, 'boolean', `${path}.options.${key}`, source);
  }
}
