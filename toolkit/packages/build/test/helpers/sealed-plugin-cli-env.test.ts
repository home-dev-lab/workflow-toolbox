import { delimiter, join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { sealedPluginCliEnv, withoutOpencodeAdmission } from './sealed-plugin-cli-env.js'

afterEach(() => { vi.unstubAllEnvs() })

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

  // A gate wrapper that exports WT_SUITE_LOCK_WAIT_S (the outer suite run's lock wait, up to 12 h) must not reach the
  // lock CLIs these tests spawn: a broker refuses a client waitS above its 10800 s ceiling, so seven suite-lock-broker
  // cases failed under such a wrapper (card 1878424989787490016). A test that needs a wait passes it explicitly.
  it('drops an ambient WT_SUITE_LOCK_WAIT_S, while an explicit override still wins', () => {
    const previous = process.env.WT_SUITE_LOCK_WAIT_S
    process.env.WT_SUITE_LOCK_WAIT_S = '43200'
    try {
      expect(sealedPluginCliEnv('/fixture', {}, 'linux').WT_SUITE_LOCK_WAIT_S).toBeUndefined()
      expect(sealedPluginCliEnv('/fixture', { WT_SUITE_LOCK_WAIT_S: '5' }, 'linux').WT_SUITE_LOCK_WAIT_S).toBe('5')
    } finally {
      if (previous === undefined) delete process.env.WT_SUITE_LOCK_WAIT_S
      else process.env.WT_SUITE_LOCK_WAIT_S = previous
    }
  })

  // A host that exports its own lane model list (WT_LANE_MODELS replaces the shipped default) must not change what
  // the spawned launcher refuses: the refusal message embeds the resolved list, so an ambient list made the
  // default-list refusal tests depend on the machine. A test that needs a list passes it explicitly.
  it('drops an ambient WT_LANE_MODELS, while an explicit override still wins', () => {
    vi.stubEnv('WT_LANE_MODELS', 'host/extra-model')
    expect(sealedPluginCliEnv('/fixture', {}, 'linux').WT_LANE_MODELS).toBeUndefined()
    expect(sealedPluginCliEnv('/fixture', { WT_LANE_MODELS: 'test/one' }, 'linux').WT_LANE_MODELS).toBe('test/one')
  })

  it('isolates both USERPROFILE and HOME on Windows', () => {
    const env = sealedPluginCliEnv('C:\\fixture', {}, 'win32')
    expect(env.HOME).toBe(join('C:\\fixture', 'home'))
    expect(env.USERPROFILE).toBe(join('C:\\fixture', 'home'))
    expect(env.CLAUDE_PLUGIN_DATA).toBeUndefined()
  })
})

describe.each(['linux', 'win32'] as const)('admission isolation on %s', (platform) => {
  it.each([
    'WT_OPENCODE_ENVELOPE_ADMISSION',
    'WT_OPENCODE_ENVELOPE_ADMISSION_TIMEOUT_MS',
    'WT_OPENCODE_VERIFY_ADMISSION',
    'WT_OPENCODE_VERIFY_ADMISSION_TIMEOUT_MS',
  ])('drops ambient %s while preserving an explicit admission fixture', (variable) => {
    vi.stubEnv(variable, 'ambient-admission-value')
    expect(sealedPluginCliEnv('/fixture', {}, platform)[variable]).toBeUndefined()
    expect(process.env[variable]).toBe('ambient-admission-value')
    expect(sealedPluginCliEnv('/fixture', { [variable]: 'explicit-fixture-value' }, platform)[variable]).toBe('explicit-fixture-value')
  })
})

it('scrubs case variants without mutating the source or dropping unrelated environment keys', () => {
  const inherited = Object.freeze({
    wt_opencode_envelope_admission: 'ambient-policy',
    Wt_Opencode_Verify_Admission_Timeout_Ms: '1',
    WT_OPENCODE_ENVELOPE_ADMISSION_TIMEOUT_MS: '2',
    WT_OPENCODE_VERIFY_ADMISSION: 'other-policy',
    Path: 'fixture-bin',
    WT_OPENCODE_OTHER_SETTING: 'preserved',
  })
  expect(withoutOpencodeAdmission(inherited)).toEqual({ Path: 'fixture-bin', WT_OPENCODE_OTHER_SETTING: 'preserved' })
  expect(Object.keys(inherited)).toHaveLength(6)
})
