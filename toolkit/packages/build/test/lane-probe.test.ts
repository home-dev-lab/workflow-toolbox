import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync, spawn, type ChildProcess } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const SCRIPT = join(REPO_ROOT, 'plugin/bin/wt-lane-probe.mjs')

// This whole suite drives a REAL live process and reads REAL /proc — it is inherently
// Linux/macOS-only (the script itself reports `cwdSupported:false` on win32 rather than
// faking a result, so there is nothing meaningful to assert there).
const supportsCwdProbe = process.platform === 'linux' || process.platform === 'darwin'
const describeIfSupported = supportsCwdProbe ? describe : describe.skip

type Verdict = {
  exitCode: number
  json: {
    platform?: string
    cwdSupported?: boolean
    pidsSupported?: boolean
    worktrees?: Array<{ worktree: string; status: string; matchedPids: number[] }>
    unattributed?: Array<{ pid: number; cwd: string; ppid: number | null; argsTruncated: string | null }>
    reason?: string
  }
}

function runProbe(args: string[]): Verdict {
  try {
    const stdout = execFileSync(process.execPath, [SCRIPT, ...args], { encoding: 'utf8' })
    return { exitCode: 0, json: JSON.parse(stdout.trim().split('\n').pop()!) }
  } catch (error) {
    const failed = error as Error & { status?: number; stdout?: string | Buffer }
    const stdout = typeof failed.stdout === 'string' ? failed.stdout : String(failed.stdout ?? '')
    return { exitCode: failed.status ?? 2, json: stdout.trim() ? JSON.parse(stdout.trim().split('\n').pop()!) : {} }
  }
}

// Same as runProbe, but through an intermediate `sh -c '<literal command>'` wrapper — the
// exact shape a caller's own Bash tool uses for a one-line command. Reproduces the real bug
// found on 2026-08-03: the wrapper shell's own argv is the literal command text, which
// contains the --pattern value too, so the probe would self-match its own invoking shell as
// an unrelated "unattributed" process unless it excludes the whole ancestor chain, not just
// its own pid.
function runProbeViaShellWrapper(args: string[]): Verdict {
  const quoted = [process.execPath, SCRIPT, ...args].map((a) => `'${a.replace(/'/g, `'\\''`)}'`).join(' ')
  try {
    const stdout = execFileSync('sh', ['-c', quoted], { encoding: 'utf8' })
    return { exitCode: 0, json: JSON.parse(stdout.trim().split('\n').pop()!) }
  } catch (error) {
    const failed = error as Error & { status?: number; stdout?: string | Buffer }
    const stdout = typeof failed.stdout === 'string' ? failed.stdout : String(failed.stdout ?? '')
    return { exitCode: failed.status ?? 2, json: stdout.trim() ? JSON.parse(stdout.trim().split('\n').pop()!) : {} }
  }
}

// Spawns a long-lived `node <fixture> <marker>` process rooted at `cwd`, so it is
// findable via `pgrep -f <marker>` and its cwd is resolvable via /proc or lsof — the exact
// mechanism the script under test uses. The marker is a fresh UUID per call so concurrent
// test runs (and unrelated processes on the machine) never collide.
function spawnFixtureProcess(cwd: string): { child: ChildProcess; marker: string } {
  const marker = `wt-lane-probe-fixture-${randomUUID()}`
  const fixtureDir = mkdtempSync(join(tmpdir(), 'wt-lane-probe-fixture-'))
  const fixtureScript = join(fixtureDir, 'sleep.mjs')
  writeFileSync(fixtureScript, 'setInterval(() => {}, 1000)\n')
  const child = spawn(process.execPath, [fixtureScript, marker], { cwd, stdio: 'ignore' })
  return { child, marker }
}

async function waitForPid(marker: string, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    try {
      const out = execFileSync('pgrep', ['-f', marker], { encoding: 'utf8' }).trim()
      if (out) return
    } catch {
      // pgrep exits 1 while no match yet — keep polling
    }
    await new Promise((r) => setTimeout(r, 50))
  }
  throw new Error(`fixture process for marker ${marker} never became visible to pgrep`)
}

describeIfSupported('wt-lane-probe.mjs', () => {
  const spawned: ChildProcess[] = []
  const dirs: string[] = []

  afterEach(() => {
    for (const child of spawned.splice(0)) {
      try {
        child.kill('SIGKILL')
      } catch {
        // already dead — fine
      }
    }
    for (const dir of dirs.splice(0)) {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  function makeWorktreeDir(): string {
    const dir = mkdtempSync(join(tmpdir(), 'wt-lane-probe-worktree-'))
    dirs.push(dir)
    return dir
  }

  it('returns a usage error when no --worktree is given', () => {
    const result = runProbe(['--pattern', 'anything'])
    expect(result.exitCode).toBe(2)
  })

  it('discriminates POSITIVE: a live process whose cwd is the worktree is reported active', async () => {
    const worktree = makeWorktreeDir()
    const { child, marker } = spawnFixtureProcess(worktree)
    spawned.push(child)
    await waitForPid(marker)

    const result = runProbe(['--worktree', worktree, '--pattern', marker])

    expect(result.exitCode).toBe(0)
    expect(result.json.worktrees).toHaveLength(1)
    const worktreeResult = result.json.worktrees?.[0]
    expect(worktreeResult).toBeDefined()
    expect(worktreeResult?.status).toBe('active')
    expect(worktreeResult?.matchedPids.length).toBeGreaterThan(0)
    expect(result.json.unattributed).toEqual([])
  })

  it('discriminates NEGATIVE: a worktree with no matching process is reported idle, never silently omitted', () => {
    const worktree = makeWorktreeDir()
    const result = runProbe(['--worktree', worktree, '--pattern', `no-such-process-${randomUUID()}`])

    expect(result.exitCode).toBe(0)
    expect(result.json.worktrees).toHaveLength(1)
    const worktreeResult = result.json.worktrees?.[0]
    expect(worktreeResult).toBeDefined()
    expect(worktreeResult?.status).toBe('idle')
    expect(worktreeResult?.matchedPids).toEqual([])
  })

  it('matches a process whose cwd is a SUBDIRECTORY of the worktree (pilots run gates from toolkit/ inside their worktree)', async () => {
    const worktree = makeWorktreeDir()
    const subdir = join(worktree, 'toolkit')
    mkdirSync(subdir)
    const { child, marker } = spawnFixtureProcess(subdir)
    spawned.push(child)
    await waitForPid(marker)

    const result = runProbe(['--worktree', worktree, '--pattern', marker])

    expect(result.json.worktrees?.[0]?.status).toBe('active')
  })

  it('reports a matching process whose cwd is NOT under any named worktree as unattributed, with cwd+ppid+args captured', async () => {
    const worktree = makeWorktreeDir()
    const elsewhere = makeWorktreeDir() // a real dir, but never passed as --worktree
    const { child, marker } = spawnFixtureProcess(elsewhere)
    spawned.push(child)
    await waitForPid(marker)

    const result = runProbe(['--worktree', worktree, '--pattern', marker])

    expect(result.json.worktrees?.[0]?.status).toBe('idle')
    expect(result.json.unattributed?.length ?? 0).toBeGreaterThan(0)
    const entry = result.json.unattributed?.[0]
    expect(entry).toBeDefined()
    expect(entry?.cwd).toContain(elsewhere.replace(/^\/private/, ''))
    expect(typeof entry?.pid).toBe('number')
    // argsTruncated is deliberately capped at 120 chars (see the script's header) — on a long
    // tmp path the full UUID marker can fall past the cutoff, so assert on its stable prefix.
    expect(entry?.argsTruncated).toContain(marker.slice(0, 24))
  })

  // Regression for a real bug found while validating this script against a live wave on
  // 2026-08-03: invoked through a one-line shell wrapper (`sh -c '<literal command>'` — the
  // exact shape a caller's own Bash tool uses), the wrapper shell's own argv contains the
  // --pattern value too. Excluding only the probe's own pid missed this: the wrapper matched
  // and showed up as a false `unattributed` anomaly on every single invocation of this shape.
  it('does not self-match its own invoking shell wrapper as an unattributed anomaly', () => {
    const worktree = makeWorktreeDir()
    const marker = `wt-lane-probe-selfmatch-${randomUUID()}`

    const result = runProbeViaShellWrapper(['--worktree', worktree, '--pattern', marker])

    expect(result.exitCode).toBe(0)
    expect(result.json.unattributed).toEqual([])
    expect(result.json.worktrees?.[0]?.status).toBe('idle')
  })

  it('archives one JSONL line per invocation, appending rather than overwriting', async () => {
    const worktree = makeWorktreeDir()
    const archiveDir = mkdtempSync(join(tmpdir(), 'wt-lane-probe-archive-'))
    dirs.push(archiveDir)
    const archivePath = join(archiveDir, 'nested', 'probe.jsonl')

    runProbe(['--worktree', worktree, '--pattern', `no-such-process-${randomUUID()}`, '--archive', archivePath])
    runProbe(['--worktree', worktree, '--pattern', `no-such-process-${randomUUID()}`, '--archive', archivePath])

    expect(existsSync(archivePath)).toBe(true)
    const lines = readFileSync(archivePath, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(() => JSON.parse(lines[0] ?? '')).not.toThrow()
    expect(() => JSON.parse(lines[1] ?? '')).not.toThrow()
  })

  // Mutation-coverage: without the `pidsSupported`/`cwdSupported` split, an environment where
  // pgrep exists but cwd resolution doesn't (or vice versa) would silently collapse into a
  // plausible-looking 'idle' on every worktree — the exact "silent zero" this script's header
  // rules out. This test's own platform gate proves the split is legible: if run somewhere
  // cwdSupported is false, every worktree must say so explicitly, never 'idle'.
  it('never reports plain "idle" when cwd resolution itself is unsupported (documents the guard the script relies on)', () => {
    // cwdSupported is guaranteed true in this describe block (linux/darwin only) — this
    // asserts the FIELD is present and true, which is what the unsupported-platform branch
    // flips to false instead of omitting.
    const worktree = makeWorktreeDir()
    const result = runProbe(['--worktree', worktree, '--pattern', `no-such-process-${randomUUID()}`])
    expect(result.json.cwdSupported).toBe(true)
    expect(result.json.pidsSupported).toBe(true)
  })
})

describe('wt-lane-probe.mjs on an unsupported platform', () => {
  it.skipIf(supportsCwdProbe)('reports cwdSupported:false explicitly instead of a plausible empty result', () => {
    const worktree = mkdtempSync(join(tmpdir(), 'wt-lane-probe-worktree-'))
    try {
      const result = runProbe(['--worktree', worktree, '--pattern', 'anything'])
      expect(result.json.cwdSupported).toBe(false)
      expect(result.json.worktrees?.[0]?.status).toBe('unknown-platform-unsupported')
    } finally {
      rmSync(worktree, { recursive: true, force: true })
    }
  })
})
