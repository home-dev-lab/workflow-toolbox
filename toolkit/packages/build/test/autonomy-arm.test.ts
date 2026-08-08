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

function projectSlug(dir: string): string {
  return resolve(dir).replace(/[^A-Za-z0-9-]/g, '-')
}

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
    // ⚠ PROJECT-KEYED — the contract with wt-autonomy-watch.mjs under test elsewhere. `--project`
    // targets `projectDir` explicitly rather than relying on `process.cwd()`, so the test does not
    // depend on where the test runner happens to be invoked from.
    mandatePath: join(stateHome, 'wt-queue-gate', `engine-${projectSlug(projectDir)}.json`),
    env: { ...process.env, XDG_STATE_HOME: stateHome, CLAUDE_CODE_SESSION_ID: sessionId },
    args: ['--project', projectDir],
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

    const armed = run(ARM, s.env, s.args)

    expect(armed.status).toBe(0)
    expect(existsSync(s.mandatePath)).toBe(true)
    expect(armed.stdout).toContain('AUTONOMY MANDATE: armed')
    // The path is in the output because a tool that writes a file the caller cannot locate is
    // one indirection short of useful.
    expect(armed.stdout).toContain(s.mandatePath)
    const record = JSON.parse(readFileSync(s.mandatePath, 'utf8')) as { sessionId: string; declaredAt: string; declaredAtMs: number }
    expect(record.sessionId).toBe(s.sessionId)
    expect(record.declaredAt).toMatch(/^\d{4}-\d{2}-\d{2}T/)
    // `declaredAtMs` is what the watcher's freshness window and provenance banner read — the
    // ISO string is for a human reader, the epoch number is what code compares against.
    expect(typeof record.declaredAtMs).toBe('number')
  })

  it('the marker is keyed on the PROJECT, not the session — two different sessions arming the same project share one marker', () => {
    const s = scaffold()

    run(ARM, { ...s.env, CLAUDE_CODE_SESSION_ID: 'session-one' }, s.args)
    expect(existsSync(s.mandatePath)).toBe(true)
    const first = JSON.parse(readFileSync(s.mandatePath, 'utf8')) as { sessionId: string }
    expect(first.sessionId).toBe('session-one')

    // A different session re-arming the SAME project overwrites the one marker — this is what
    // lets a restarted session's watcher inherit a mandate a prior session declared: there is
    // exactly one live marker per project, never one per session.
    run(ARM, { ...s.env, CLAUDE_CODE_SESSION_ID: 'session-two' }, s.args)
    const second = JSON.parse(readFileSync(s.mandatePath, 'utf8')) as { sessionId: string }
    expect(second.sessionId).toBe('session-two')
  })

  it('reports armed and not-armed through the EXIT CODE, so a caller need not parse prose', () => {
    const s = scaffold()

    const before = run(ARM, s.env, [...s.args, '--status'])
    expect(before.status).toBe(1)
    expect(before.stdout).toContain('not armed')

    run(ARM, s.env, s.args)

    const after = run(ARM, s.env, [...s.args, '--status'])
    expect(after.status).toBe(0)
    expect(after.stdout).toContain('armed')
  })

  it('withdraws the mandate, and withdrawing twice is not an error', () => {
    const s = scaffold()
    run(ARM, s.env, s.args)
    expect(existsSync(s.mandatePath)).toBe(true)

    const first = run(ARM, s.env, [...s.args, '--disarm'])
    expect(first.status).toBe(0)
    expect(existsSync(s.mandatePath)).toBe(false)

    const second = run(ARM, s.env, [...s.args, '--disarm'])
    expect(second.status).toBe(0)
    expect(second.stdout).toContain('already not armed')
  })

  it('refuses to guess a session id rather than writing a marker nothing will read', () => {
    const s = scaffold()
    const env = Object.fromEntries(Object.entries(s.env).filter(([k]) => k !== 'CLAUDE_CODE_SESSION_ID'))

    const result = run(ARM, env, s.args)

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
    run(ARM, s.env, s.args)

    const result = run(WATCH, { ...s.env, CLAUDE_CONFIG_DIR: join(s.root, 'config') }, ['--once', '--project', s.projectDir])

    expect(result.stdout).toContain('mandate=present')
    expect(result.stdout).toContain('wt-queue-not-empty-gate-hook.mjs')
  })

  it('names NEITHER remedy once both preconditions are satisfied', () => {
    const s = scaffold()
    run(ARM, s.env, s.args)
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

// `--status` and the watcher used to each carry their own freshness check, and disagreed about the
// SAME marker at the SAME instant: the watcher correctly reported `mandate=stale(540min) · CANNOT
// FIRE` while `--status` still said `armed`. Both now share one classifier
// (lib/autonomy-mandate.mjs) — these lock the three states `--status` must distinguish, and that
// it never again reports "armed" about a marker the watcher would refuse to honour.
function writeMandate(mandatePath: string, sessionId: string, declaredAtMs: number) {
  writeFileSync(
    mandatePath,
    `${JSON.stringify({ sessionId, declaredAtMs, declaredAt: new Date(declaredAtMs).toISOString() })}\n`,
  )
}

describe('--status distinguishes live, expired and absent — and agrees with the watcher', () => {
  it('a fresh mandate reports armed/live through exit code 0', () => {
    const s = scaffold()
    writeMandate(s.mandatePath, s.sessionId, Date.now() - 5 * 60_000)

    const result = run(ARM, s.env, [...s.args, '--status'])

    expect(result.status).toBe(0)
    expect(result.stdout).toContain('AUTONOMY MANDATE: armed')
    expect(result.stdout).not.toContain('expired')
  })

  it('a mandate past the freshness window reports EXPIRED — never armed — through a DISTINCT exit code', () => {
    const s = scaffold()
    writeMandate(s.mandatePath, s.sessionId, Date.now() - 9 * 60 * 60_000) // 9h ago, default window is 8h

    const result = run(ARM, s.env, [...s.args, '--status'])

    // ⚠ The regression this whole block exists to lock: this line must NEVER read "armed" about a
    // marker that has already expired — that was the exact defect reported (watcher said
    // `CANNOT FIRE`, --status said `armed`, same file, same instant).
    expect(result.stdout).not.toContain('AUTONOMY MANDATE: armed')
    expect(result.stdout).toContain('AUTONOMY MANDATE: expired')
    expect(result.stdout).toContain('will NOT fire')
    expect(result.status).toBe(3)
    expect(result.status).not.toBe(0)
    expect(result.status).not.toBe(1) // distinct from "no marker at all"
  })

  it('no marker at all reports not armed through exit code 1 — distinct from expired', () => {
    const s = scaffold()

    const result = run(ARM, s.env, [...s.args, '--status'])

    expect(result.stdout).toContain('AUTONOMY MANDATE: not armed')
    expect(result.stdout).not.toContain('expired')
    expect(result.status).toBe(1)
  })

  it('the watcher banner and --status AGREE about the same expired marker at the same instant — the regression this locks', () => {
    const s = scaffold()
    const now = Date.now()
    writeMandate(s.mandatePath, s.sessionId, now - 9 * 60 * 60_000)

    const status = run(ARM, s.env, [...s.args, '--status'])
    const watch = run(WATCH, { ...s.env, CLAUDE_CONFIG_DIR: join(s.root, 'config') }, ['--once', '--project', s.projectDir])

    // The watcher's banner says CANNOT FIRE / stale; --status must say the equivalent, never
    // "armed" — the two tools reporting on one file must never contradict each other.
    expect(watch.stdout).toContain('mandate=stale(')
    expect(watch.stdout).toContain('CANNOT FIRE')
    expect(status.stdout).not.toContain('AUTONOMY MANDATE: armed')
    expect(status.stdout).toContain('expired')
  })

  it('the watcher banner and --status AGREE about the same LIVE marker at the same instant', () => {
    const s = scaffold()
    const now = Date.now()
    writeMandate(s.mandatePath, s.sessionId, now - 5 * 60_000)
    // A fresh queue snapshot too, so the watcher's banner isn't independently blocked by the
    // OTHER precondition (queue) — this test is about the mandate readout agreeing, not about
    // whether every precondition happens to be satisfied.
    const queueSlug = `${s.projectDir.replace(/[^A-Za-z0-9]/g, '-').slice(0, 120)}-${createHash('sha1').update(s.projectDir).digest('hex').slice(0, 12)}`
    writeFileSync(
      join(s.stateHome, 'wt-queue-gate', `queue-${queueSlug}.json`),
      `${JSON.stringify({ at: now, open: 1, next: 'CARD-X keep going' })}\n`,
    )

    const status = run(ARM, s.env, [...s.args, '--status'])
    const watch = run(WATCH, { ...s.env, CLAUDE_CONFIG_DIR: join(s.root, 'config') }, ['--once', '--project', s.projectDir])

    expect(watch.stdout).toContain('mandate=present')
    expect(watch.stdout).not.toContain('CANNOT FIRE')
    expect(status.stdout).toContain('AUTONOMY MANDATE: armed')
    expect(status.status).toBe(0)
  })
})
