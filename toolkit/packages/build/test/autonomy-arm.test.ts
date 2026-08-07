import { afterEach, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { createHash } from 'node:crypto'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = fileURLToPath(new URL('.', import.meta.url))
const ARM = resolve(HERE, '../../../../plugin/bin/wt-autonomy-arm.mjs')
const WATCH = resolve(HERE, '../../../../plugin/bin/wt-autonomy-watch.mjs')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

function scaffold() {
  const root = mkdtempSync(join(tmpdir(), 'wt-autonomy-arm-'))
  roots.push(root)
  const stateHome = join(root, 'state-home')
  const projectDir = join(root, 'project')
  mkdirSync(join(stateHome, 'wt-queue-gate'), { recursive: true })
  mkdirSync(projectDir, { recursive: true })
  const sessionId = 'session-under-test'
  return {
    root,
    stateHome,
    projectDir,
    sessionId,
    mandatePath: join(stateHome, 'wt-queue-gate', `engine-${sessionId}.json`),
    env: { ...process.env, XDG_STATE_HOME: stateHome, CLAUDE_CODE_SESSION_ID: sessionId },
  }
}

function run(script: string, env: NodeJS.ProcessEnv, args: string[] = []) {
  const res = spawnSync(process.execPath, [script, ...args], { encoding: 'utf8', env, timeout: 10_000 })
  return { status: res.status, stdout: res.stdout.trim() }
}

describe('wt-autonomy-arm declares the mandate the watcher refuses to run without', () => {
  it('writes the marker at the path the watcher reads, and says where', () => {
    const s = scaffold()
    expect(existsSync(s.mandatePath)).toBe(false)

    const armed = run(ARM, s.env)

    expect(armed.status).toBe(0)
    expect(existsSync(s.mandatePath)).toBe(true)
    expect(armed.stdout).toContain('AUTONOMY MANDATE: armed')
    // The path is in the output because a tool that writes a file the caller cannot locate is
    // one indirection short of useful.
    expect(armed.stdout).toContain(s.mandatePath)
    const record = JSON.parse(readFileSync(s.mandatePath, 'utf8')) as { sessionId: string; declaredAt: string }
    expect(record.sessionId).toBe(s.sessionId)
    expect(record.declaredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
  })

  it('reports armed and not-armed through the EXIT CODE, so a caller need not parse prose', () => {
    const s = scaffold()

    const before = run(ARM, s.env, ['--status'])
    expect(before.status).toBe(1)
    expect(before.stdout).toContain('not armed')

    run(ARM, s.env)

    const after = run(ARM, s.env, ['--status'])
    expect(after.status).toBe(0)
    expect(after.stdout).toContain('armed')
  })

  it('withdraws the mandate, and withdrawing twice is not an error', () => {
    const s = scaffold()
    run(ARM, s.env)
    expect(existsSync(s.mandatePath)).toBe(true)

    const first = run(ARM, s.env, ['--disarm'])
    expect(first.status).toBe(0)
    expect(existsSync(s.mandatePath)).toBe(false)

    const second = run(ARM, s.env, ['--disarm'])
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('already not armed')
  })

  it('refuses to guess a session id rather than writing a marker nothing will read', () => {
    const s = scaffold()
    const env = Object.fromEntries(Object.entries(s.env).filter(([k]) => k !== 'CLAUDE_CODE_SESSION_ID'))

    const result = run(ARM, env)

    expect(result.status).toBe(2)
    expect(result.stdout).toContain('CLAUDE_CODE_SESSION_ID is not set')
    expect(existsSync(s.mandatePath)).toBe(false)
  })
})

// A diagnosis that does not carry its remedy leaves a reader knowing it is broken and not what to
// do — which is where a reader gives up. These assert the banner names the thing that supplies
// each missing piece, by the name a reader can actually act on.
describe('the watcher banner names what supplies each missing precondition', () => {
  it('names the arming tool when the mandate is absent', () => {
    const s = scaffold()
    const result = run(WATCH, { ...s.env, CLAUDE_CONFIG_DIR: join(s.root, 'config') }, ['--once', '--project', s.projectDir])

    expect(result.stdout).toContain('mandate=absent')
    expect(result.stdout).toContain('wt-autonomy-arm.mjs')
  })

  it('names the queue-snapshot hook when the snapshot is missing', () => {
    const s = scaffold()
    run(ARM, s.env)

    const result = run(WATCH, { ...s.env, CLAUDE_CONFIG_DIR: join(s.root, 'config') }, ['--once', '--project', s.projectDir])

    expect(result.stdout).toContain('mandate=present')
    expect(result.stdout).toContain('wt-queue-not-empty-gate-hook.mjs')
  })

  it('names NEITHER remedy once both preconditions are satisfied', () => {
    const s = scaffold()
    run(ARM, s.env)
    const queueSlug = `${s.projectDir.replace(/[^A-Za-z0-9]/g, '-').slice(0, 120)}-${createHash('sha1').update(s.projectDir).digest('hex').slice(0, 12)}`
    writeFileSync(
      join(s.stateHome, 'wt-queue-gate', `queue-${queueSlug}.json`),
      `${JSON.stringify({ at: Date.now(), open: 2, next: 'CARD-2 do the thing' })}\n`,
    )

    const result = run(WATCH, { ...s.env, CLAUDE_CONFIG_DIR: join(s.root, 'config') }, ['--once', '--project', s.projectDir])

    expect(result.stdout).toContain('queue=fresh')
    expect(result.stdout).not.toContain('CANNOT FIRE')
    expect(result.stdout).not.toContain('wt-autonomy-arm.mjs')
  })
})
