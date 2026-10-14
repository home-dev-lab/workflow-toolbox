import { join } from 'node:path'

export function sealedPluginCliEnv(
  root: string,
  overrides: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const home = join(root, 'home')
  return {
    ...process.env,
    WT_SUITE_LOCK_PRIORITY: undefined,
    WT_SUITE_LOCK_LONG_HOLD_S: undefined,
    PATH: process.env.PATH,
    NPM_CONFIG_PREFIX: join(root, 'npm-prefix'),
    XDG_STATE_HOME: join(root, 'state'),
    CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
    CLAUDE_PLUGIN_DATA: undefined,
    // The outer gate run's own lock wait (a wrapper may export up to 12 h) is not the spawned CLI's: a broker refuses
    // a client waitS above 10800 s. A test that needs a wait passes it as an override.
    WT_SUITE_LOCK_WAIT_S: undefined,
    HOME: home,
    USERPROFILE: platform === 'win32' ? home : undefined,
    ...overrides,
  }
}
