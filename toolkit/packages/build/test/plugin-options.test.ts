import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error Standalone plugin helpers have no declaration surface.
import { resolveWorkflowToolboxOption } from '../../../../plugin/bin/lib/plugin-options.mjs'

const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

const cases = [
  { option: 'lane_skills', envKey: 'WT_LANE_SKILLS', optionValue: 'option-skill', envValue: 'env-skill', defaultValue: '' },
  { option: 'lane_models', envKey: 'WT_LANE_MODELS', optionValue: 'option/model', envValue: 'env/model', defaultValue: 'openai/gpt-5.6-luna,openai/gpt-5.6-terra,openai/gpt-5.6-sol,openai/gpt-6-astra' },
  { option: 'artifact_server', envKey: 'WT_ARTIFACT_SERVER', optionValue: false, envValue: '1', defaultValue: true },
  { option: 'artifact_server_roots', envKey: 'WT_ARTIFACT_SERVER_ROOTS', optionValue: 'option=/root', envValue: 'env=/root', defaultValue: null },
  { option: 'artifact_server_port', envKey: 'WT_ARTIFACT_SERVER_PORT', optionValue: 49123, envValue: '49124', defaultValue: null },
  { option: 'artifact_server_idle_grace_s', envKey: 'WT_ARTIFACT_SERVER_IDLE_GRACE_S', optionValue: 42, envValue: '43', defaultValue: 600 },
  { option: 'artifact_server_deny', envKey: 'WT_ARTIFACT_SERVER_DENY', optionValue: '*.option', envValue: '*.env', defaultValue: '' },
  { option: 'planka_mcp_url', envKey: 'WT_PLANKA_MCP_URL', optionValue: 'http://option:1/mcp', envValue: 'http://env:2/mcp', defaultValue: 'http://localhost:25478/mcp' },
] as const

function fixture(settings?: unknown) {
  const root = mkdtempSync(join(tmpdir(), 'wt-plugin-options-'))
  roots.push(root)
  const config = join(root, 'config')
  mkdirSync(config)
  if (settings !== undefined) writeFileSync(join(config, 'settings.json'), JSON.stringify(settings))
  return { config, env: { CLAUDE_CONFIG_DIR: config } as NodeJS.ProcessEnv }
}

describe('workflow-toolbox plugin option resolver', () => {
  it.each(cases)('$option: plugin option wins over env', ({ option, envKey, optionValue, envValue }) => {
    const f = fixture({ pluginConfigs: { 'workflow-toolbox@local': { options: { [option]: optionValue } } } })
    f.env[envKey] = envValue
    expect(resolveWorkflowToolboxOption(option, { env: f.env })).toEqual({ value: optionValue, source: 'plugin option' })
  })

  it.each(cases)('$option: env is used without a plugin option', ({ option, envKey, envValue }) => {
    const f = fixture({})
    f.env[envKey] = envValue
    const expected = option === 'artifact_server_port' || option === 'artifact_server_idle_grace_s'
      ? Number(envValue)
      : option === 'artifact_server'
        ? true
        : envValue
    expect(resolveWorkflowToolboxOption(option, { env: f.env })).toEqual({ value: expected, source: 'env' })
  })

  it.each(cases)('$option: default is used without option or env', ({ option, defaultValue }) => {
    const f = fixture({})
    expect(resolveWorkflowToolboxOption(option, { env: f.env })).toEqual({ value: defaultValue, source: 'default' })
  })

  it('falls back to env when settings.json is invalid or unreadable', () => {
    const invalid = fixture()
    writeFileSync(join(invalid.config, 'settings.json'), '{')
    invalid.env.WT_LANE_MODELS = 'env/model'
    expect(resolveWorkflowToolboxOption('lane_models', { env: invalid.env })).toEqual({ value: 'env/model', source: 'env' })

    const unreadable = fixture()
    mkdirSync(join(unreadable.config, 'settings.json'))
    unreadable.env.WT_LANE_MODELS = 'env/model'
    expect(resolveWorkflowToolboxOption('lane_models', { env: unreadable.env })).toEqual({ value: 'env/model', source: 'env' })
  })
})
