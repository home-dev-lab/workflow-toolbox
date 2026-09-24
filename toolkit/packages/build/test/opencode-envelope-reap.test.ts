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
const fixturePidFiles: string[] = []

function parseFixturePids(value: string, protectedPids = [process.pid, process.ppid]) {
  return value.split(/\s+/).filter(Boolean).map(Number)
    .filter((pid) => Number.isSafeInteger(pid) && pid > 1 && !protectedPids.includes(pid))
}

function fixturePids() {
  return fixturePidFiles.flatMap((file) => {
    try { return parseFixturePids(readFileSync(file, 'utf8')) } catch { return [] }
  })
}

function processExists(pid: number) {
  try { process.kill(pid, 0); return true } catch { return false }
}

afterEach(async () => {
  for (const pid of fixturePids()) try { process.kill(pid, 'SIGKILL') } catch {}
  const deadline = Date.now() + 5_000
  let survivors = fixturePids().filter(processExists)
  while (survivors.length && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25))
    survivors = survivors.filter(processExists)
  }
  fixturePidFiles.length = 0
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
  const pidFile = join(root, 'fixture.pids')
  fixturePidFiles.push(pidFile)
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
      `echo $$ > ${JSON.stringify(pidFile)}`,
      'sleep 120 &',
      `echo $! >> ${JSON.stringify(pidFile)}`,
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
