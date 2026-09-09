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

describe('pilot model configuration', () => {
  it('resolves process env ahead of settings env, and settings ahead of sonnet defaults', () => {
    expect(resolvePilotModels({
      env: { WT_PILOT_MODEL: 'haiku' },
      settingsEnv: { WT_PILOT_MODEL: 'opus', WT_PILOT_HARD_MODEL: 'fable' },
    })).toEqual({
      pilot: { value: 'haiku', source: 'env' },
      pilotHard: { value: 'fable', source: 'settings' },
      orchestrator: { value: 'sonnet', source: 'default' },
    })
  })

  it('uses sonnet for every unresolved key', () => {
    expect(resolvePilotModels({ env: {}, settingsEnv: {} })).toEqual({
      pilot: { value: 'sonnet', source: 'default' },
      pilotHard: { value: 'sonnet', source: 'default' },
      orchestrator: { value: 'sonnet', source: 'default' },
    })
  })

  it('accepts harness aliases and full Claude ids', () => {
    for (const value of ['haiku', 'sonnet', 'opus', 'fable', 'claude-3-7-sonnet-latest']) {
      expect(assertHarnessModel(value)).toBe(value)
    }
  })

  it('refuses GPT and other non-harness values with the SDK-pilot follow-up', () => {
    for (const value of ['openai/gpt-5.6-luna', 'gpt-4o', 'codex', 'zai', '']) {
      expect(() => assertHarnessModel(value)).toThrow(
        'GPT pilot runs as an opencode runner; see the SDK-pilot spike card',
      )
    }
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
      env: { ...process.env, CLAUDE_CONFIG_DIR: config },
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
      env: { ...process.env, CLAUDE_CONFIG_DIR: config },
      encoding: 'utf8',
    })
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('GPT pilot runs as an opencode runner')
    expect(result.stderr).toContain('SDK-pilot spike card')
    expect(result.stdout).toBe('')
  })
})
