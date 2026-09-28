export function cleanEnv(overrides = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('CLAUDE_PLUGIN_') && !key.startsWith('WT_ROD_')
    && !['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS', 'CLAUDE_CODE_ENTRYPOINT'].includes(key)));
  return { ...base, ...overrides };
}
