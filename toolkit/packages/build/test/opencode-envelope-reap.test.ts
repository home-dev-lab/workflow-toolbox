import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { inspectProcess, sameIdentity } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/bin/wt-opencode-envelope.mjs')
const IDENTITY_MODULE = new URL('../../../../plugin/bin/lib/lane-supervisor-core.mjs', import.meta.url).href
const roots: string[] = []

// ⚠ The stub starts real background processes. If a run is interrupted between spawning them and
// the envelope reaping them, they outlive this suite — which is the exact defect under test, so
// the cleanup is bounded HERE at teardown rather than trusted to the thing being tested.
const fixturePidFiles: string[] = []

function parseFixturePids(value: string, protectedPids = [process.pid, process.ppid]) {
  return value.split(/\s+/).filter(Boolean).map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 1 && !protectedPids.includes(pid))
}

type FixtureIdentity = { pid: number, argv: string[], startTime: number, cwd?: string | null }

function fixtureIdentities() {
  return fixturePidFiles.flatMap((file) => {
    try {
      return readFileSync(file, 'utf8').trim().split(/\r?\n/).flatMap((line) => {
        try {
          const identity = JSON.parse(line)
          return Number.isSafeInteger(identity?.pid) && identity.pid > 1 && Array.isArray(identity.argv) && Number.isFinite(identity.startTime)
            ? [identity as FixtureIdentity]
            : []
        } catch { return [] }
      })
    } catch { return [] }
  })
}

function signalFixtureIdentity(identity: FixtureIdentity, inspect: (pid: number) => FixtureIdentity | null, signal: (pid: number, signal: NodeJS.Signals) => void) {
  const actual = inspect(identity.pid)
  if (!actual) return 'identity unknown'
  if (!sameIdentity(identity, actual)) return 'identity changed'
  signal(identity.pid, 'SIGKILL')
  return 'signalled'
}

afterEach(async () => {
  const identities = fixtureIdentities()
  for (const identity of identities) {
    try { signalFixtureIdentity(identity, (pid) => inspectProcess(pid, { recordedArgv: identity.argv }), process.kill) } catch {}
  }
  const deadline = Date.now() + 5_000
  let survivors = identities.filter((identity) => sameIdentity(identity, inspectProcess(identity.pid, { recordedArgv: identity.argv })))
  while (survivors.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    survivors = survivors.filter((identity) => sameIdentity(identity, inspectProcess(identity.pid, { recordedArgv: identity.argv })))
  }
  fixturePidFiles.length = 0
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (survivors.length) throw new Error(`envelope fixture leaked child pids: ${survivors.map(({ pid }) => pid).join(', ')}`)
})

/** A stub `opencode` whose `run` subcommand starts a background child that INHERITS the caller's
 * stdout pipe, then blocks. Every other invocation (binary discovery, provider probe) returns at
 * once, so a hang can only come from the task path. */
function makeStubRoot() {
  const root = mkdtempSync(join(tmpdir(), 'wt-opencode-envelope-reap-'))
  roots.push(root)
  const bin = join(root, 'bin')
  const pidFile = join(root, 'fixture.pids')
  const recorder = join(root, 'record-identity.mjs')
  fixturePidFiles.push(pidFile)
  spawnSync('mkdir', ['-p', bin])
  const stub = join(bin, 'opencode')
  writeFileSync(recorder, `import { appendFileSync } from 'node:fs'; import { inspectProcess } from ${JSON.stringify(IDENTITY_MODULE)}; const pid=Number(process.argv[2]); const identity=inspectProcess(pid); if(identity) appendFileSync(${JSON.stringify(pidFile)},JSON.stringify(identity)+'\\n')\n`)
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = "--version" ]; then echo "fixture-1"; exit 0; fi',
      'if [ "$1" = "--pure" ]; then echo "[{\\"name\\":\\"workflow-toolbox-allowed-sentinel\\"}]"; exit 0; fi',
      'if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then echo "[]"; exit 0; fi',
      'if [ "$1" != "run" ]; then echo "openai/gpt-5.4"; exit 0; fi',
      // Inherits stdout — this is what used to keep node's `close` from ever firing.
      `${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} $$`,
      'sleep 120 &',
      `${JSON.stringify(process.execPath)} ${JSON.stringify(recorder)} $!`,
      'echo "child started"',
      'exec sleep 120',
    ].join('\n'),
    'utf8',
  )
  chmodSync(stub, 0o755)
  writeFileSync(join(root, 'tasks.json'), JSON.stringify([{ id: 'reap', prompt: 'hi' }]), 'utf8')
  return { root, bin }
}

describe('wt-opencode-envelope reaps the process group of a stopped call', () => {
  it('never treats receipt whitespace, process groups, or the test runner as fixture PIDs', () => {
    expect(parseFixturePids(`12345\n0\n-123\n${process.pid}\n${process.ppid}\n`)).toEqual([12345])
  })

  it('never signals a stale fixture receipt whose PID has a different identity', () => {
    const signal = vi.fn()
    const captured = { pid: 12345, startTime: 100, argv: ['fixture'] }

    expect(signalFixtureIdentity(captured, () => ({ ...captured, startTime: 101 }), signal)).toBe('identity changed')
    expect(signal).not.toHaveBeenCalled()
  })

  // ⚠ THE LOCK. Reverting `detached: true` / the group signal in wt-opencode-envelope.mjs makes
  // this test HANG rather than fail an assertion, which the harness surfaces as a timeout — the
  // measured pre-fix behaviour was "alive past 45s on a 5s timeout, zero bytes of output".
  // Proven RED against the pre-change file before this test was accepted: rc=124, 0-byte log,
  // no manifest. Do not weaken the timeout below without re-establishing that.
  it.skip('completes its timeout even when a descendant holds the child stdout pipe [host probe excluded from default suite: requires real POSIX process-group scheduling]', () => {
    const { root, bin } = makeStubRoot()
    const started = Date.now()
    const run = spawnSync(
      process.execPath,
      [SCRIPT, join(root, 'tasks.json'), '--dir', root, '--timeout-sec', '3'],
      { encoding: 'utf8', timeout: 30_000, env: { ...process.env, PATH: `${bin}:${process.env.PATH ?? ''}` } },
    )
    const elapsedMs = Date.now() - started

    // The deciding assertion: it FINISHED. Before the fix this call was still running when the
    // outer guard killed it, and produced no output at all.
    expect(run.status).toBe(0)
    expect(elapsedMs).toBeLessThan(25_000)

    const manifestLine = String(run.stdout ?? '')
    expect(manifestLine).toMatch(/^MANIFEST: /m)

    const manifestPath = /^MANIFEST: ([^\s]+)/m.exec(manifestLine)?.[1]
    expect(manifestPath).toBeDefined()
    expect(existsSync(manifestPath!)).toBe(true)
    const manifest = JSON.parse(readFileSync(manifestPath!, 'utf8'))
    expect(manifest.tasks).toHaveLength(1)

    // Cleanup is LEGIBLE, not silent: on a platform that can be asked, the count is present.
    // It is deliberately not asserted to be any particular number — the point is that the field
    // exists and is a measurement, never a zero standing in for "nobody looked".
    if (process.platform !== 'win32') {
      expect(typeof manifest.tasks[0].reaped).toBe('number')
    }
  })
})
