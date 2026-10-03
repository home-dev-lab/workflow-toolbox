import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const managedPolicyArgs = ['--import', new URL('../test-support/managed-policy-fixture.mjs', import.meta.url).href];

export function cleanEnv(overrides = {}) {
  const base = Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !key.startsWith('CLAUDE_PLUGIN_') && !key.startsWith('WT_ROD_')
    && !['CLAUDE_CONFIG_DIR', 'CLAUDE_CODE_ENABLE_FUNCTION_HOOKS', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_EXECPATH', 'AI_AGENT'].includes(key)));
  // Tests never consult host managed policy; individual fixtures may supply a real test file.
  return { ...base, NODE_OPTIONS: '',
    WT_ROD_TEST_MANAGED_SETTINGS: join(tmpdir(), `rod-absent-managed-${process.pid}`, 'managed-settings.json'), ...overrides };
}
