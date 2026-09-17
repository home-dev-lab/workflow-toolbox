import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/bin/wt-opencode-envelope.mjs')
const roots: string[] = []

// ⚠ The stub starts real background processes. If a run is interrupted between spawning them and
// the envelope reaping them, they outlive this suite — which is the exact defect under test, so
// the cleanup is bounded HERE at teardown rather than trusted to the thing being tested.
const SENTINEL = 'wt-reap-test-sentinel'

function sentinelPids() {
  const listed = spawnSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
  if (listed.status !== 0 || typeof listed.stdout !== 'string') throw new Error('cannot enumerate envelope fixture children with ps')
  const pids: number[] = []
  for (const line of listed.stdout.split('\n')) {
    if (!line.includes(SENTINEL)) continue
    const pid = Number(line.trim().split(/\s+/)[0])
    if (Number.isInteger(pid)) pids.push(pid)
  }
  return pids
}

afterEach(async () => {
  for (const pid of sentinelPids()) try { process.kill(pid, 'SIGKILL') } catch {}
  const deadline = Date.now() + 5_000
  let survivors = sentinelPids()
  while (survivors.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    survivors = sentinelPids()
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
  if (survivors.length) throw new Error(`envelope fixture leaked child pids: ${survivors.join(', ')}`)
})

/** A stub `opencode` whose `run` subcommand starts a background child that INHERITS the caller's
 * stdout pipe, then blocks. Every other invocation (binary discovery, provider probe) returns at
 * once, so a hang can only come from the task path. */
function makeStubRoot() {
  const root = mkdtempSync(join(tmpdir(), 'wt-opencode-envelope-reap-'))
  roots.push(root)
  const bin = join(root, 'bin')
  spawnSync('mkdir', ['-p', bin])
  const stub = join(bin, 'opencode')
  writeFileSync(
    stub,
    [
      '#!/usr/bin/env bash',
      'if [ "$1" = "--version" ]; then echo "fixture-1"; exit 0; fi',
      'if [ "$1" = "--pure" ]; then echo "[{\\"name\\":\\"workflow-toolbox-allowed-sentinel\\"}]"; exit 0; fi',
      'if [ "$1" = "debug" ] && [ "$2" = "skill" ]; then echo "[]"; exit 0; fi',
      'if [ "$1" != "run" ]; then echo "openai/gpt-5.4"; exit 0; fi',
      // Inherits stdout — this is what used to keep node's `close` from ever firing.
      `sleep 120 & # ${SENTINEL}`,
      'echo "child started"',
      `exec sleep 120 # ${SENTINEL}`,
    ].join('\n'),
    'utf8',
  )
  chmodSync(stub, 0o755)
  writeFileSync(join(root, 'tasks.json'), JSON.stringify([{ id: 'reap', prompt: 'hi' }]), 'utf8')
  return { root, bin }
}

describe('wt-opencode-envelope reaps the process group of a stopped call', () => {
  // ⚠ THE LOCK. Reverting `detached: true` / the group signal in wt-opencode-envelope.mjs makes
  // this test HANG rather than fail an assertion, which the harness surfaces as a timeout — the
  // measured pre-fix behaviour was "alive past 45s on a 5s timeout, zero bytes of output".
  // Proven RED against the pre-change file before this test was accepted: rc=124, 0-byte log,
  // no manifest. Do not weaken the timeout below without re-establishing that.
  it.skipIf(process.platform === 'win32')('completes its timeout even when a descendant holds the child stdout pipe [POSIX process-group fixture]', () => {
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
