import { join } from 'node:path'
import { afterEach, beforeEach } from 'vitest'

const ADMISSION_VARIABLE = /^WT_OPENCODE_(?:ENVELOPE|VERIFY)_ADMISSION(?:_TIMEOUT_MS)?$/i

// Clone before scrubbing; callers may opt back in with their own explicit fixture overrides.
export function withoutOpencodeAdmission(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([name]) =>
    !ADMISSION_VARIABLE.test(name)))
}

// Scope ambient admission removal to these fixture tests, including in-process launcher calls.
export function isolateOpencodeAdmission(): void {
  let saved: NodeJS.ProcessEnv = {}
  beforeEach(() => {
    saved = Object.fromEntries(Object.entries(process.env).filter(([name]) => ADMISSION_VARIABLE.test(name)))
    for (const name of Object.keys(saved)) delete process.env[name]
  })
  afterEach(() => {
    for (const name of Object.keys(process.env)) {
      if (ADMISSION_VARIABLE.test(name)) delete process.env[name]
    }
    Object.assign(process.env, saved)
  })
}

export function sealedPluginCliEnv(
  root: string,
  overrides: NodeJS.ProcessEnv = {},
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const home = join(root, 'home')
  return {
    ...withoutOpencodeAdmission(),
    WT_SUITE_LOCK_PRIORITY: undefined,
    WT_SUITE_LOCK_LONG_HOLD_S: undefined,
    WT_SUITE_LOCK_LIGHT_HOLD_S: undefined,
    WT_SUITE_LOCK_OFFLOAD_COMMAND: undefined,
    WT_SUITE_LOCK_OFFLOAD_MIN_AHEAD: undefined,
    WT_SUITE_LOCK_LANE_TOKEN: undefined,
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
