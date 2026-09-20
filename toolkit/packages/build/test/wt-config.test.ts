import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(REPO_ROOT, 'plugin/bin/wt-config.mjs')
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-config-context-hook.mjs')
const roots: string[] = []

afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'wt-config-'))
  roots.push(root)
  const config = join(root, 'claude-config')
  const project = join(root, 'project')
  mkdirSync(join(config, 'plugins'), { recursive: true })
  mkdirSync(project)
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ pluginConfigs: {
    'workflow-toolbox@market': { options: { lane_skills: 'reviewing' } },
    'wt-what-is-running@inline': { options: { linkBase: 'http://localhost:8080' } },
  } }))
  writeFileSync(join(config, 'plugins', 'installed_plugins.json'), JSON.stringify({ plugins: { 'workflow-toolbox@market': [{}] } }))
  const env = sealedPluginCliEnv(root)
  for (const key of Object.keys(env)) if (/^WT_.*(?:MODEL|SKILLS|SERVER|PLANKA|LANE|BRANCH|REFRESH|PCT)/.test(key)) env[key] = undefined
  return { root, config, project, env }
}

describe('wt-config', () => {
  it('prints effective values and orphan move targets as JSON', () => {
    const f = fixture()
    const result = spawnSync(process.execPath, [CLI, '--json'], { cwd: f.project, env: f.env, encoding: 'utf8' })
    expect(result.status).toBe(0)
    expect(result.stderr).toBe('')
    const output = JSON.parse(result.stdout)
    expect(output.options.find((row: { option: string }) => row.option === 'lane_skills')).toMatchObject({ effective: 'reviewing', source: 'plugin option' })
    expect(output.orphanedPluginConfigs).toEqual([{ key: 'wt-what-is-running@inline', moves: [{ option: 'linkBase', target: 'workflow-toolbox@market.options.linkBase' }] }])
  })

  it('prints the env value when a model plugin option contains only whitespace', () => {
    const f = fixture()
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ pluginConfigs: {
      'workflow-toolbox@market': { options: { pilot_model: '   ' } },
    } }))
    f.env.WT_PILOT_MODEL = 'haiku'
    const result = spawnSync(process.execPath, [CLI, '--json'], { cwd: f.project, env: f.env, encoding: 'utf8' })
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout)
    expect(output.options.find((row: { option: string }) => row.option === 'pilot_model')).toMatchObject({ effective: 'haiku', source: 'env' })
  })

  it('emits main-session context and stays silent for a subagent', () => {
    const f = fixture()
    const run = (payload: unknown) => spawnSync(process.execPath, [HOOK], { cwd: f.project, env: f.env, input: JSON.stringify(payload), encoding: 'utf8' })
    const main = run({ hook_event_name: 'SessionStart', cwd: f.project })
    expect(main.status).toBe(0)
    expect(main.stderr).toBe('')
    const context = JSON.parse(main.stdout).hookSpecificOutput.additionalContext
    expect(context).toContain('lane_skills=reviewing (plugin option)')
    expect(context).toContain('wt-what-is-running@inline')
    expect(context).toContain('not auto-migrated')
    expect(run({ hook_event_name: 'SessionStart', cwd: f.project, agent_id: 'child' }).stdout).toBe('')
  })

  it('reports the fallback in SessionStart context when a model plugin option is empty', () => {
    const f = fixture()
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ pluginConfigs: {
      'workflow-toolbox@market': { options: { orchestrator_model: '' } },
    } }))
    f.env.WT_ORCHESTRATOR_MODEL = 'haiku'
    const result = spawnSync(process.execPath, [HOOK], {
      cwd: f.project,
      env: f.env,
      input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: f.project }),
      encoding: 'utf8',
    })
    expect(result.status).toBe(0)
    const context = JSON.parse(result.stdout).hookSpecificOutput.additionalContext
    expect(context).toContain('orchestrator_model=haiku (env)')
    expect(context).not.toContain('orchestrator_model= (plugin option)')
  })
})
