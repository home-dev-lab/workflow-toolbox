import { spawn, spawnSync, type ChildProcessWithoutNullStreams } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { inspectProcess } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'
import { sealedPluginCliEnv } from './helpers/sealed-plugin-cli-env.js'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const FLOOR = join(REPO_ROOT, 'plugin/bin/wt-wake-floor.mjs')
const MONITORS_JSON = join(REPO_ROOT, 'plugin/monitors/monitors.json')
const roots: string[] = []
const children: ChildProcessWithoutNullStreams[] = []
const FLOOR_LINE = 'FLOOR: 0.001 minutes elapsed on my interval. I measure only that — not whether you are idle, and not whether work remains. Check the queue yourself.'

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
  const gitEnv = sealedPluginCliEnv(root, { GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' })
  expect(spawnSync('git', ['init', projectDir], { env: gitEnv }).status).toBe(0)
  expect(spawnSync('git', ['-C', projectDir, '-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '--allow-empty', '-m', 'root'], { env: gitEnv }).status).toBe(0)
  return { gitEnv, mandatePath, projectDir, root, stateDir, stateHome }
}

function liveMandate(mandatePath: string): void {
  const declaredAtMs = Date.now()
  writeFileSync(mandatePath, `${JSON.stringify({ declaredAtMs, sessionId: 'session-under-test' })}\n`)
}

function envFor(stateHome: string, overrides: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return sealedPluginCliEnv(resolve(stateHome, '..'), {
    CLAUDE_CODE_SESSION_ID: 'session-under-test',
    GIT_CONFIG_GLOBAL: '/dev/null',
    GIT_CONFIG_NOSYSTEM: '1',
    WT_WAKE_FLOOR_IDLE_MINUTES: '0.001',
    XDG_STATE_HOME: stateHome,
    ...overrides,
  })
}

function sleeper() {
  const childRoot = mkdtempSync(join(tmpdir(), 'wt-wake-floor-child-'))
  roots.push(childRoot)
  const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { env: sealedPluginCliEnv(childRoot) })
  children.push(child)
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const identity = inspectProcess(child.pid)
    if (identity) return identity
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 10)
  }
  throw new Error('sleeper identity unavailable')
}

function writeLaneRecord(worktree: string, overrides: Record<string, unknown> = {}) {
  const worker = sleeper()
  const child = sleeper()
  const runId = `${Date.now()}-${process.pid}`
  const dir = join(worktree, '.lane', 'supervision')
  mkdirSync(dir, { recursive: true })
  const value = {
    version: 1,
    runId,
    state: 'running',
    owner: 'session',
    ownerSessionId: 'session-under-test',
    workerPid: worker.pid,
    workerArgv: worker.argv,
    workerStartTime: worker.startTime,
    childPid: child.pid,
    childArgv: child.argv,
    childStartTime: child.startTime,
    ...overrides,
  }
  writeFileSync(join(dir, `${runId}.json`), `${JSON.stringify(value)}\n`)
  writeFileSync(join(dir, 'current.json'), `${JSON.stringify({ version: 1, runId })}\n`)
  return { child, value, worker }
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
  it('relay sessions print the skip line and leave the state directory empty', () => {
    const state = scaffold('relay')
    const result = runOnce(state.projectDir, { ...envFor(state.stateHome), WT_SESSION_ROLE: 'RELAY' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("WAKE FLOOR NOT ARMED: relay session (WT_SESSION_ROLE=relay) — this session only relays; it cannot act on this watcher's events\n")
    expect(readdirSync(state.stateDir)).toEqual([])
  })

  it('with a live mandate emits after the idle period and again on the same cadence', async () => {
    const state = scaffold('cadence')
    liveMandate(state.mandatePath)

    const lines = await collectEmissions(state.projectDir, envFor(state.stateHome), 2)

    expect(lines).toEqual([
      FLOOR_LINE,
      FLOOR_LINE,
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

  it.runIf(process.platform === 'linux')('stays silent for an identity-verified live lane owned by this session', () => {
    const state = scaffold('owned-live')
    liveMandate(state.mandatePath)
    writeLaneRecord(state.projectDir)

    const result = runOnce(state.projectDir, envFor(state.stateHome))

    expect(result.status).toBe(0)
    expect(result.stdout).toBe('')
  })

  it.runIf(process.platform === 'linux')('losslessly discovers an owned lane in a worktree path containing a newline', () => {
    const state = scaffold('newline-worktree')
    liveMandate(state.mandatePath)
    const lane = join(state.root, 'lane\nsecond-line')
    expect(spawnSync('git', ['-C', state.projectDir, 'worktree', 'add', '--detach', lane], { env: state.gitEnv }).status).toBe(0)
    writeLaneRecord(lane)

    const result = runOnce(state.projectDir, envFor(state.stateHome))

    expect(result.stdout).toBe('')
  })

  it.runIf(process.platform === 'linux').each([
    ['another session', { ownerSessionId: 'other-session' }],
    ['a pilot', { owner: 'pilot' }],
  ])('still fires for a live lane owned by %s', (_label, overrides) => {
    const state = scaffold('not-owned')
    liveMandate(state.mandatePath)
    writeLaneRecord(state.projectDir, overrides)

    const result = runOnce(state.projectDir, envFor(state.stateHome))

    expect(result.stdout).toBe(`${FLOOR_LINE}\n`)
  })

  it.runIf(process.platform === 'linux')('fires inconclusively for a live lane with unavailable identity', () => {
    const state = scaffold('identity-unknown')
    liveMandate(state.mandatePath)
    writeLaneRecord(state.projectDir, { workerArgv: null, workerStartTime: null, workerIdentity: 'unavailable (proc)' })

    const result = runOnce(state.projectDir, envFor(state.stateHome))

    expect(result.stdout).toMatch(/^FLOOR: .* In-flight check inconclusive \(/)
  })

  it('fires inconclusively when git cannot be inspected', () => {
    const state = scaffold('git-unavailable')
    liveMandate(state.mandatePath)
    const emptyPath = join(state.root, 'empty-path')
    mkdirSync(emptyPath)

    const result = runOnce(state.projectDir, envFor(state.stateHome, { PATH: emptyPath }))

    expect(result.stdout).toContain('In-flight check inconclusive (git worktree list unavailable)')
  })

  it('does not mistake recently completed task and transcript files for in-flight work', () => {
    const state = scaffold('completed-files')
    liveMandate(state.mandatePath)
    mkdirSync(join(state.projectDir, 'tasks'), { recursive: true })
    mkdirSync(join(state.projectDir, 'subagents'), { recursive: true })
    writeFileSync(join(state.projectDir, 'tasks', 'completed.output'), 'done\n')
    writeFileSync(join(state.projectDir, 'subagents', 'completed.jsonl'), '{"status":"completed"}\n')

    const result = runOnce(state.projectDir, envFor(state.stateHome))

    expect(result.stdout).toBe(`${FLOOR_LINE}\n`)
  })

  it('keeps thrown-check detail to one line and 200 characters', () => {
    const state = scaffold('throwing-check')
    liveMandate(state.mandatePath)
    const stub = join(state.root, 'stub.mjs')
    const hooks = join(state.root, 'hooks.mjs')
    const preload = join(state.root, 'preload.mjs')
    const detail = `first\r\n${'x'.repeat(250)}`
    writeFileSync(stub, `export function sessionLaneInFlight() { throw new Error(${JSON.stringify(detail)}) }\n`)
    writeFileSync(hooks, `import { pathToFileURL } from 'node:url'\nexport async function resolve(specifier, context, nextResolve) {\n  if (specifier.endsWith('/wake-floor-in-flight.mjs')) return { url: pathToFileURL(${JSON.stringify(stub)}).href, shortCircuit: true }\n  return nextResolve(specifier, context)\n}\n`)
    writeFileSync(preload, `import { register } from 'node:module'\nregister(${JSON.stringify(pathToFileURL(hooks).href)})\n`)

    const result = runOnce(state.projectDir, envFor(state.stateHome, { NODE_OPTIONS: `--import=${pathToFileURL(preload).href}` }))
    const normalized = `in-flight check threw: ${detail}`.replace(/[\r\n]+/g, ' ').slice(0, 200)

    expect(result.status).toBe(0)
    expect(result.stdout).toBe(`${FLOOR_LINE} In-flight check inconclusive (${normalized}); firing because I cannot tell whether a lane of this session is running.\n`)
    expect(result.stdout.trim().split('\n')).toHaveLength(1)
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
