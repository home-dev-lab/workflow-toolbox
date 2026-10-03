import { objectSettings, refuse } from './managed-policy.mjs';

const foundType = (value) => value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
function expect(settings, key, type, path, source) {
  if (!Object.hasOwn(settings, key)) return;
  const value = settings[key];
  if (type === 'object' ? !objectSettings(value) : typeof value !== type)
    refuse(`${source}: ${path}: expected ${type}, found ${foundType(value)}`);
}

export function assertPolicyTypes(settings, source) {
  for (const key of ['disableAllHooks', 'allowManagedHooksOnly', 'disableSideloadFlags'])
    expect(settings, key, 'boolean', key, source);
  for (const key of ['enabledPlugins', 'pluginConfigs', 'env']) expect(settings, key, 'object', key, source);
  if (settings.env) expect(settings.env, 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS', 'string', 'env.CLAUDE_CODE_ENABLE_FUNCTION_HOOKS', source);
  for (const name of Object.keys(settings.enabledPlugins ?? {})) {
    if (name.startsWith('wt-rules-on-demand@')) expect(settings.enabledPlugins, name, 'boolean', `enabledPlugins["${name}"]`, source);
  }
  for (const [name, config] of Object.entries(settings.pluginConfigs ?? {})) {
    if (name !== 'cc-plugin-sec-default@builtin' && !name.startsWith('wt-rules-on-demand@')) continue;
    const path = `pluginConfigs["${name}"]`;
    expect(settings.pluginConfigs, name, 'object', path, source);
    expect(config, 'options', 'object', `${path}.options`, source);
    if (!config.options) continue;
    const key = name === 'cc-plugin-sec-default@builtin' ? 'allowManagedModsOnly' : 'enabled';
    expect(config.options, key, 'boolean', `${path}.options.${key}`, source);
  }
}
