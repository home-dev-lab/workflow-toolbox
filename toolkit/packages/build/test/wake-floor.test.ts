import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FLOOR = join(REPO_ROOT, 'plugin/bin/wt-wake-floor.mjs')
const MONITORS_JSON = join(REPO_ROOT, 'plugin/monitors/monitors.json')
const roots: string[] = []
const children: ChildProcessWithoutNullStreams[] = []

afterEach(() => {
  for (const child of children.splice(0)) child.kill()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function projectSlug(dir: string): string {
  return resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

function scaffold(tag: string) {
  const root = mkdtempSync(join(tmpdir(), `wt-wake-floor-${tag}-`))
  roots.push(root)
  const projectDir = join(root, 'project')
  const stateHome = join(root, 'state-home')
  const stateDir = join(stateHome, 'wt-queue-gate')
  const mandatePath = join(stateDir, `engine-${projectSlug(projectDir)}.json`)
  mkdirSync(projectDir, { recursive: true })
  mkdirSync(stateDir, { recursive: true })
  return { mandatePath, projectDir, stateDir, stateHome }
}

function liveMandate(mandatePath: string): void {
  const declaredAtMs = Date.now()
  writeFileSync(mandatePath, `${JSON.stringify({ declaredAtMs, sessionId: 'session-under-test' })}\n`)
}

function envFor(stateHome: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    CLAUDE_CODE_SESSION_ID: 'session-under-test',
    WT_WAKE_FLOOR_IDLE_MINUTES: '0.001',
    XDG_STATE_HOME: stateHome,
  }
}

function runOnce(projectDir: string, env: NodeJS.ProcessEnv) {
  return spawnSync(process.execPath, [FLOOR, '--once', '--project', projectDir], {
    encoding: 'utf8',
    env,
    timeout: 5_000,
  })
}

function observe(projectDir: string, env: NodeJS.ProcessEnv, milliseconds: number): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [FLOOR, '--project', projectDir], { env })
    children.push(child)
    let stdout = ''
    let stderr = ''
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })
    child.on('error', reject)
    setTimeout(() => {
      child.kill()
      if (stderr) reject(new Error(stderr))
      else resolvePromise(stdout.split('\n').filter(Boolean))
    }, milliseconds)
  })
}

function collectEmissions(projectDir: string, env: NodeJS.ProcessEnv, count: number): Promise<string[]> {
  return new Promise((resolvePromise, reject) => {
    const child = spawn(process.execPath, [FLOOR, '--project', projectDir], { env })
    children.push(child)
    const lines: string[] = []
    let stdout = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`timed out waiting for ${count} emissions; received ${lines.length}`))
    }, 5_000)
    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => {
      stdout += chunk
      const complete = stdout.split('\n')
      stdout = complete.pop() ?? ''
      lines.push(...complete.filter(Boolean))
      if (lines.length >= count) {
        clearTimeout(timeout)
        child.kill()
        resolvePromise(lines)
      }
    })
    child.stderr.on('data', (chunk) => {
      clearTimeout(timeout)
      reject(new Error(String(chunk)))
    })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
  })
}

describe('wt-wake-floor', () => {
  it('with a live mandate emits after the idle period and again on the same cadence', async () => {
    const state = scaffold('cadence')
    liveMandate(state.mandatePath)

    const lines = await collectEmissions(state.projectDir, envFor(state.stateHome), 2)

    expect(lines).toEqual([
      'FLOOR: 0.001 minutes elapsed on my interval. I measure only that — not whether you are idle, and not whether work remains. Check the queue yourself.',
      'FLOOR: 0.001 minutes elapsed on my interval. I measure only that — not whether you are idle, and not whether work remains. Check the queue yourself.',
    ])
  })

  it('with no mandate emits nothing across multiple cadences', async () => {
    const state = scaffold('no-mandate')

    const lines = await observe(state.projectDir, envFor(state.stateHome), 500)

    expect(lines).toEqual([])
  })

  it('speaks with a live mandate when the queue snapshot is absent or stale', () => {
    const absent = scaffold('queue-absent')
    const stale = scaffold('queue-stale')
    liveMandate(absent.mandatePath)
    liveMandate(stale.mandatePath)
    const queueSlug = `${stale.projectDir.replace(/[^A-Za-z0-9]/g, '-').slice(0, 120)}-${createHash('sha1').update(stale.projectDir).digest('hex').slice(0, 12)}`
    writeFileSync(join(stale.stateDir, `queue-${queueSlug}.json`), `${JSON.stringify({
      at: Date.now() - 3 * 60 * 60_000,
      open: 118,
      next: 'state that silenced autonomy-watch',
    })}\n`)

    const absentResult = runOnce(absent.projectDir, envFor(absent.stateHome))
    const staleResult = runOnce(stale.projectDir, envFor(stale.stateHome))

    expect(absentResult.status).toBe(0)
    expect(staleResult.status).toBe(0)
    expect(absentResult.stdout.trim().startsWith('FLOOR: 0.001 minutes elapsed on my interval.')).toBe(true)
    expect(staleResult.stdout.trim().startsWith('FLOOR: 0.001 minutes elapsed on my interval.')).toBe(true)
  })

  it('treats an unreadable mandate as absent instead of crashing', () => {
    const state = scaffold('bad-mandate')
    writeFileSync(state.mandatePath, '{not-json')

    const result = runOnce(state.projectDir, envFor(state.stateHome))

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
    expect(result.stderr).toBe('')
  })

  it('supports the sibling --help convention', () => {
    const result = spawnSync(process.execPath, [FLOOR, '--help'], { encoding: 'utf8' })

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('wt-wake-floor')
    expect(result.stdout).toContain('--project <dir>')
    expect(result.stdout).toContain('--poll <seconds>')
    expect(result.stderr).toBe('')
  })
})

describe('monitors.json registers wake-floor', () => {
  it('points at wt-wake-floor.mjs and is armed unconditionally', () => {
    const monitors = JSON.parse(readFileSync(MONITORS_JSON, 'utf8')) as Array<{ name: string; command: string; when: string }>
    const entry = monitors.find((monitor) => monitor.name === 'wake-floor')

    expect(entry).toBeTruthy()
    expect(entry?.command).toContain('wt-wake-floor.mjs')
    expect(entry?.when).toBe('always')
  })
})
