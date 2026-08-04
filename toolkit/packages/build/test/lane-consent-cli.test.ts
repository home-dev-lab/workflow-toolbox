import { spawnSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(REPO_ROOT, 'plugin/bin/wt-lane-consent.mjs')
const KEY = 'WT_EXECUTOR_LANE_CONSENT'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-lane-consent-cli-${tag}-`))
  roots.push(root)
  const project = join(root, 'project')
  const config = join(root, 'config')
  const home = join(root, 'home')
  for (const dir of [project, config, home]) mkdirSync(dir, { recursive: true })
  return { root, project, config, env: { ...process.env, HOME: home, CLAUDE_CONFIG_DIR: config } }
}

function run(f: ReturnType<typeof fixture>, args: string[]) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: f.env,
    cwd: f.project,
  })
}

function accountSettings(f: ReturnType<typeof fixture>) {
  return JSON.parse(readFileSync(join(f.config, 'settings.json'), 'utf8'))
}

describe('wt-lane-consent CLI', () => {
  it('reports REFUSED when nothing is set — the default is OFF, and it says so in every state', () => {
    const f = fixture('default-off')
    const res = run(f, [])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('EFFECTIVE: REFUSED')
    expect(res.stdout).toContain('not set')
  })

  it('--on writes the account ceiling and the effective verdict flips to ALLOWED', () => {
    const f = fixture('turn-on')
    const res = run(f, ['--on'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('EFFECTIVE: ALLOWED')
    expect(accountSettings(f).env[KEY]).toBe('true')
  })

  it('preserves every other key and backs the file up before writing', () => {
    const f = fixture('preserve')
    writeFileSync(
      join(f.config, 'settings.json'),
      JSON.stringify({ model: 'opus', env: { SOMETHING_ELSE: 'kept' } }, null, 2),
    )
    const res = run(f, ['--on'])
    expect(res.status).toBe(0)
    const after = accountSettings(f)
    expect(after.model).toBe('opus')
    expect(after.env.SOMETHING_ELSE).toBe('kept')
    expect(after.env[KEY]).toBe('true')
    const backup = JSON.parse(readFileSync(join(f.config, 'settings.json.bak-lane-consent'), 'utf8'))
    expect(backup.env[KEY]).toBeUndefined()
  })

  it('a project can NARROW an allowing account, and the reason names the project', () => {
    const f = fixture('narrow')
    run(f, ['--on'])
    const res = run(f, ['--project', f.project, '--off'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('EFFECTIVE: REFUSED')
    expect(res.stdout).toContain('narrows the account ceiling')
  })

  it('a project can NEVER widen a refusing account — turning the project on changes nothing', () => {
    const f = fixture('cannot-widen')
    const res = run(f, ['--project', f.project, '--on'])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('EFFECTIVE: REFUSED')
    expect(res.stdout).toContain('account has not opted in')
  })

  it('never prints the raw stored value — state is reported in words', () => {
    const f = fixture('no-leak')
    const res = run(f, ['--on'])
    expect(res.stdout).not.toContain('"true"')
  })

  it('an unreadable settings file yields UNKNOWN, never a reassuring default', () => {
    const f = fixture('unknown')
    writeFileSync(join(f.config, 'settings.json'), '{ not json')
    const res = run(f, [])
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('EFFECTIVE: UNKNOWN')
  })

  it('--json reports the effective state machine-readably', () => {
    const f = fixture('json')
    run(f, ['--on'])
    const res = run(f, ['--json'])
    const parsed = JSON.parse(res.stdout)
    expect(parsed.key).toBe(KEY)
    expect(parsed.effective).toBe('allowed')
    expect(parsed.written).toEqual([])
  })
})
