import { join } from 'node:path'

export function sealedPluginCliEnv(
  root: string,
  overrides: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const home = join(root, 'home')
  return {
    ...process.env,
    PATH: process.env.PATH,
    NPM_CONFIG_PREFIX: join(root, 'npm-prefix'),
    XDG_STATE_HOME: join(root, 'state'),
    CLAUDE_CONFIG_DIR: join(root, 'claude-config'),
    CLAUDE_PLUGIN_DATA: undefined,
    HOME: platform === 'win32' ? undefined : home,
    USERPROFILE: platform === 'win32' ? home : undefined,
    ...overrides,
  }
}
