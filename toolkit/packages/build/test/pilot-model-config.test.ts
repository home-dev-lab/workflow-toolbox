import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { assertHarnessModel, resolvePilotModels } from '../../../../plugin/bin/lib/pilot-model-config.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(REPO_ROOT, 'plugin/bin/wt-pilot-models.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// The CLI reads the ambient process env ahead of the profile's settings env, so a machine whose own
// profile sets WT_*_MODEL or ANTHROPIC_DEFAULT_*_MODEL would make these fixtures read the machine, not
// the fixture (measured 2026-09-09: `source=env` on a host with WT_PILOT_MODEL=opus in its settings env).
function scrubbedEnv(extra: Record<string, string>): Record<string, string> {
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue
    if (/^WT_(PILOT|PILOT_HARD|ORCHESTRATOR)_MODEL$/.test(key) || /^ANTHROPIC_DEFAULT_[A-Z0-9_]+_MODEL$/.test(key)) continue
    env[key] = value
  }
  return { ...env, ...extra }
}

describe('pilot model configuration', () => {
  it('resolves process env ahead of settings env, and settings ahead of sonnet defaults', () => {
    expect(resolvePilotModels({
      env: { WT_PILOT_MODEL: 'haiku' },
      settingsEnv: { WT_PILOT_MODEL: 'opus', WT_PILOT_HARD_MODEL: 'fable' },
    })).toEqual({
      pilot: { value: 'haiku', source: 'env', effective: 'haiku', remappedBy: null },
      pilotHard: { value: 'fable', source: 'settings', effective: 'fable', remappedBy: null },
      orchestrator: { value: 'sonnet', source: 'default', effective: 'sonnet', remappedBy: null },
    })
  })

  it('uses sonnet for every unresolved key', () => {
    expect(resolvePilotModels({ env: {}, settingsEnv: {} })).toEqual({
      pilot: { value: 'sonnet', source: 'default', effective: 'sonnet', remappedBy: null },
      pilotHard: { value: 'sonnet', source: 'default', effective: 'sonnet', remappedBy: null },
      orchestrator: { value: 'sonnet', source: 'default', effective: 'sonnet', remappedBy: null },
    })
  })

  it('accepts harness aliases and full Claude ids', () => {
    for (const value of ['haiku', 'sonnet', 'opus', 'fable', 'claude-3-7-sonnet-latest']) {
      expect(assertHarnessModel(value)).toBe(value)
    }
  })

  it('refuses GPT and other non-harness values with the alias-remap remedy (Frederic, wt-suite #1536)', () => {
    for (const value of ['openai/gpt-5.6-luna', 'gpt-4o', 'codex', 'zai', '']) {
      expect(() => assertHarnessModel(value)).toThrow(
        'keep the alias (sonnet, opus, fable) and remap it in the profile env with ANTHROPIC_DEFAULT_<ALIAS>_MODEL',
      )
    }
  })

  it('reports the EFFECTIVE model a profile remaps an alias to, env over settings, alias untouched otherwise', () => {
    const models = resolvePilotModels({
      env: { WT_PILOT_MODEL: 'sonnet', ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.6-terra' },
      settingsEnv: { ANTHROPIC_DEFAULT_SONNET_MODEL: 'gpt-5.6-luna', WT_PILOT_HARD_MODEL: 'fable', ANTHROPIC_DEFAULT_FABLE_MODEL: 'gpt-6-astra', WT_ORCHESTRATOR_MODEL: 'claude-sonnet-5' },
    })
    expect(models.pilot).toMatchObject({ value: 'sonnet', source: 'env', effective: 'gpt-5.6-terra', remappedBy: 'ANTHROPIC_DEFAULT_SONNET_MODEL (env)' })
    expect(models.pilotHard).toMatchObject({ value: 'fable', source: 'settings', effective: 'gpt-6-astra', remappedBy: 'ANTHROPIC_DEFAULT_FABLE_MODEL (settings)' })
    expect(models.orchestrator).toMatchObject({ value: 'claude-sonnet-5', effective: 'claude-sonnet-5', remappedBy: null })
    const plain = resolvePilotModels({ env: {}, settingsEnv: {} })
    expect(plain.pilot).toMatchObject({ value: 'sonnet', source: 'default', effective: 'sonnet', remappedBy: null })
  })

  it('prints only the three resolved lines and succeeds for a settings profile', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-pilot-models-cli-'))
    roots.push(root)
    const config = join(root, 'config')
    mkdirSync(config)
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: {
      WT_PILOT_MODEL: 'haiku',
      WT_PILOT_HARD_MODEL: 'opus',
      WT_ORCHESTRATOR_MODEL: 'claude-3-5-sonnet-latest',
    } }))
    const result = spawnSync(process.execPath, [CLI], {
      cwd: root,
      env: scrubbedEnv({ CLAUDE_CONFIG_DIR: config }),
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe([
      'pilot=haiku (source=settings)',
      'pilotHard=opus (source=settings)',
      'orchestrator=claude-3-5-sonnet-latest (source=settings)',
      '',
    ].join('\n'))
    expect(result.stderr).toBe('')
  })

  it('exits 2 and names the refusal when a settings value is not a harness model', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-pilot-models-cli-refused-'))
    roots.push(root)
    const config = join(root, 'config')
    mkdirSync(config)
    writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { WT_PILOT_MODEL: 'openai/gpt-5.6-luna' } }))
    const result = spawnSync(process.execPath, [CLI], {
      cwd: root,
      env: scrubbedEnv({ CLAUDE_CONFIG_DIR: config }),
      encoding: 'utf8',
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('keep the alias (sonnet, opus, fable) and remap it in the profile env')
    expect(result.stderr).toContain('refused model value: openai/gpt-5.6-luna')
    expect(result.stdout).toBe('')
  })
})
