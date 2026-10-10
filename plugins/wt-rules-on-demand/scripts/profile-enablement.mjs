// Reconstruct only the readable user/managed fields used by the profile checker.
// Managed fields override user fields; sorted drop-ins override the base policy.
export function profileEnablement(user, policies) {
  const enabledPlugins = { ...user.enabledPlugins };
  const options = Object.fromEntries(Object.entries(user.pluginConfigs ?? {}).map(([id, config]) => [id, { ...config?.options }]));
  const env = { ...user.env };
  let allowManagedModsOnly;
  const hooks = Object.fromEntries(['disableAllHooks', 'allowManagedHooksOnly', 'disableSideloadFlags'].map((key) => [key, user[key]]));
  for (const { settings } of policies) {
    // This security option is managed policy, not a user-configurable prohibition.
    const guard = settings.pluginConfigs?.['cc-plugin-sec-default@builtin']?.options ?? {};
    if (Object.hasOwn(guard, 'allowManagedModsOnly')) allowManagedModsOnly = guard.allowManagedModsOnly;
    Object.assign(enabledPlugins, settings.enabledPlugins);
    Object.assign(env, settings.env);
    mergePolicyFields(settings, hooks, options);
  }
  const affirmative = Object.keys(options).filter((id) => id.startsWith('wt-rules-on-demand@')
    && options[id].enabled === true && enabledPlugins[id] !== false);
  const listed = affirmative.filter((id) => enabledPlugins[id] === true);
  return { enabledPlugins, options, affirmative, listed, env, ...hooks, allowManagedModsOnly };
}

function mergePolicyFields(settings, hooks, options) {
  for (const key of Object.keys(hooks)) if (Object.hasOwn(settings, key)) hooks[key] = settings[key];
  for (const [id, config] of Object.entries(settings.pluginConfigs ?? {})) {
    options[id] = { ...options[id], ...config?.options };
  }
}
