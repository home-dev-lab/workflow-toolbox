import { delimiter, join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './sealed-plugin-cli-env.js'

describe('sealedPluginCliEnv', () => {
  it('isolates plugin state while preserving executable lookup on POSIX', () => {
    const env = sealedPluginCliEnv('/fixture', { PATH: `/fixture/bin${delimiter}${process.env.PATH ?? ''}` }, 'linux')
    expect(env).toMatchObject({
      HOME: join('/fixture', 'home'),
      NPM_CONFIG_PREFIX: join('/fixture', 'npm-prefix'),
      XDG_STATE_HOME: join('/fixture', 'state'),
      CLAUDE_CONFIG_DIR: join('/fixture', 'claude-config'),
    })
    expect(env.PATH).toContain('/fixture/bin')
    expect(env.CLAUDE_PLUGIN_DATA).toBeUndefined()
    expect(env.USERPROFILE).toBeUndefined()
  })

  it('uses USERPROFILE and removes HOME on Windows', () => {
    const env = sealedPluginCliEnv('C:\\fixture', {}, 'win32')
    expect(env.HOME).toBeUndefined()
    expect(env.USERPROFILE).toBe(join('C:\\fixture', 'home'))
    expect(env.CLAUDE_PLUGIN_DATA).toBeUndefined()
  })
})
