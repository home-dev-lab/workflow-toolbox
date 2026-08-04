import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(REPO_ROOT, 'plugin/bin/wt-lane-consent-check.mjs')
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-lane-consent-check-hook.mjs')

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function mkRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `wt-lane-consent-${tag}-`))
  roots.push(root)
  return root
}

function fixture(tag: string) {
  const root = mkRoot(tag)
  const project = join(root, 'project')
  const config = join(root, 'config')
  const home = join(root, 'home')
  mkdirSync(project, { recursive: true })
  mkdirSync(config, { recursive: true })
  mkdirSync(home, { recursive: true })
  return {
    project,
    config,
    env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config },
  }
}

function writeRule(dir: string, body: string) {
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'wt-delegation-ladder.md'), body)
}

function runCli(project: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [CLI, '--project', project], { encoding: 'utf8', env })
}

function runHook(project: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [HOOK], {
    input: JSON.stringify({ hook_event_name: 'SessionStart', cwd: project }),
    encoding: 'utf8',
    env,
  })
}

const DEFAULT_RULE = `# Delegation ladder

- A heavy implementation increment of one card -> the card's executor lane.

Heavy work is a standing default for delegation to a cheaper executor lane.
`

const NON_DEFAULT_RULE = `# Delegation ladder

Use an executor lane only when explicitly requested and separately consented.
`

describe('wt-lane-consent-check', () => {
  it('detects and names both sides when lane-default rules meet absent consent', () => {
    const f = fixture('mismatch')
    writeRule(join(f.config, 'rules'), DEFAULT_RULE)

    const res = runCli(f.project, f.env)

    expect(res.status).toBe(1)
    expect(res.stdout).toContain('DISAGREEMENT')
    expect(res.stdout).toContain(join(f.config, 'rules', 'wt-delegation-ladder.md'))
    expect(res.stdout).toContain(join(f.config, 'settings.json'))
    expect(res.stdout).toContain(join(f.project, '.claude', 'settings.local.json'))
    expect(res.stdout).not.toContain('"true"')
  })

  it('stays silent when a lane-default rule is present and account consent resolves true', () => {
    const f = fixture('consented')
    writeRule(join(f.config, 'rules'), DEFAULT_RULE)
    writeFileSync(join(f.config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))

    const res = runCli(f.project, f.env)

    expect(res.status).toBe(0)
    expect((res.stdout ?? '').trim()).toBe('')
  })

  it('stays silent when no active rule declares the lane a default', () => {
    const f = fixture('ordinary')
    writeRule(join(f.config, 'rules'), NON_DEFAULT_RULE)

    const res = runCli(f.project, f.env)

    expect(res.status).toBe(0)
    expect((res.stdout ?? '').trim()).toBe('')
  })

  it('reports UNKNOWN on an unreadable or invalid settings link instead of folding it into absent', () => {
    const f = fixture('unknown')
    writeRule(join(f.config, 'rules'), DEFAULT_RULE)
    writeFileSync(join(f.config, 'settings.json'), '{ not-json')

    const res = runCli(f.project, f.env)

    expect(res.status).toBe(2)
    expect(res.stdout).toContain('UNKNOWN')
    expect(res.stdout).toContain(join(f.config, 'settings.json'))
  })

  it('surfaces the same mismatch at SessionStart through the hook wrapper', () => {
    const f = fixture('hook')
    writeRule(join(f.project, '.claude', 'rules'), DEFAULT_RULE)

    const res = runHook(f.project, f.env)

    expect(res.status).toBe(0)
    expect(res.stdout).toContain('hookSpecificOutput')
    expect(res.stdout).toContain('DISAGREEMENT')
  })
})
