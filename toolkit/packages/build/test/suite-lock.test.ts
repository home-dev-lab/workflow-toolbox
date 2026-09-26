import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { acquireSuiteLock, readSuiteLock, releaseSuiteLock, spawnNeedsShell, windowsShimArgumentRefusal } from '../../../../plugin/bin/lib/suite-lock.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(ROOT, 'plugin/bin/wt-suite-lock.mjs')
const RUNNER = join(ROOT, 'plugin/bin/wt-suite-lock-run.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function tempRoot(tag: string): string {
  const root = mkdtempSync(join(tmpdir(), `wt-suite-lock-${tag}-`))
  roots.push(root)
  return root
}

function cli(args: string[], root: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, WT_SUITE_LOCK_DIR: root, ...extraEnv },
  })
}

function runAsync(args: string[], root: string) {
  const child = spawn(process.execPath, [CLI, ...args], {
    env: { ...process.env, WT_SUITE_LOCK_DIR: root },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stderr = ''
  child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
  return { child, stderr: () => stderr, done: new Promise<number | null>((resolve) => child.once('exit', resolve)) }
}

async function waitFor(predicate: () => boolean, timeoutMs = 3000) {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for fixture state')
    await new Promise((resolve) => setTimeout(resolve, 20))
  }
}

describe('suite lock library', () => {
  it('writes the holder shape and gives the lock to a waiter after release', async () => {
    const root = tempRoot('handoff')
    const first = await acquireSuiteLock({ root, argv: ['pnpm', 'test'] })
    expect(readSuiteLock({ root }).holder).toEqual({
      pid: process.pid,
      argv: ['pnpm', 'test'],
      cwd: process.cwd(),
      startedAt: expect.any(String),
      platform: process.platform,
      pidNamespace: process.platform === 'linux' ? expect.stringMatching(/^pid:\[\d+\]$/) : null,
      startTime: process.platform === 'linux' ? expect.any(Number) : null,
    })
    let acquired = false
    const secondPromise = acquireSuiteLock({ root, pollMs: 10, noticeMs: 10, waitS: 1 }).then((lease: unknown) => { acquired = true; return lease })
    await new Promise((resolve) => setTimeout(resolve, 40))
    expect(acquired).toBe(false)
    expect(releaseSuiteLock(first)).toBe(true)
    const second = await secondPromise
    expect(releaseSuiteLock(second)).toBe(true)
  })

  it('reclaims a holder whose pid is dead', async () => {
    const root = tempRoot('stale')
    const lock = join(root, 'lock.d')
    const seeded = await acquireSuiteLock({ root })
    writeFileSync(join(lock, 'holder.json'), `${JSON.stringify({ ...seeded.holder, pid: 2_147_483_647 })}\n`)
    const replacement = await acquireSuiteLock({ root, waitS: 0.1, pollMs: 10 })
    expect(replacement.holder.pid).toBe(process.pid)
    expect(releaseSuiteLock(replacement)).toBe(true)
  })
})

describe('wt-suite-lock CLI', () => {
  it('times out with 75 and never runs the command', async () => {
    const root = tempRoot('timeout')
    const marker = join(root, 'ran')
    const lease = await acquireSuiteLock({ root })
    const result = cli(['run', '--wait-s', '0.05', '--', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], root)
    expect(result.status).toBe(75)
    expect(result.stderr).toContain('timed out waiting for suite lock: holder pid')
    expect(existsSync(marker)).toBe(false)
    releaseSuiteLock(lease)
  })

  it('bypasses visibly and runs when WT_SUITE_LOCK=0', () => {
    const root = tempRoot('bypass')
    const result = cli(['run', '--', process.execPath, '-e', 'process.stdout.write("ran")'], root, { WT_SUITE_LOCK: '0' })
    expect(result.status).toBe(0)
    expect(result.stdout).toBe('ran')
    expect(result.stderr).toContain('bypassed because WT_SUITE_LOCK=0')
  })

  it('serializes two real run commands and reports the holder', async () => {
    const root = tempRoot('integration')
    const program = 'setTimeout(() => {}, 3000)'
    const started = Date.now()
    const first = runAsync(['run', '--', process.execPath, '-e', program], root)
    await waitFor(() => existsSync(join(root, 'lock.d', 'holder.json')))
    await new Promise((resolve) => setTimeout(resolve, 1000))
    const second = runAsync(['run', '--', process.execPath, '-e', program], root)
    expect(await first.done).toBe(0)
    expect(await second.done).toBe(0)
    expect(Date.now() - started).toBeGreaterThanOrEqual(5900)
    expect(second.stderr()).toMatch(/waiting for suite lock: holder pid \d+ \(.+\) since \d\d:\d\d/)
    expect(existsSync(join(root, 'lock.d'))).toBe(false)
  }, 10_000)

  it('reports status as JSON and release refuses a live holder without force', async () => {
    const root = tempRoot('operator')
    const lease = await acquireSuiteLock({ root })
    const status = cli(['status', '--json'], root)
    expect(JSON.parse(status.stdout)).toMatchObject({ held: true, holder: { pid: process.pid } })
    const refused = cli(['release'], root)
    expect(refused.status).toBe(1)
    expect(refused.stderr).toContain('refused to release live holder')
    expect(readFileSync(join(root, 'lock.d', 'holder.json'), 'utf8')).toContain(`"pid": ${process.pid}`)
    expect(cli(['release', '--force'], root).status).toBe(0)
    expect(releaseSuiteLock(lease)).toBe(true)
  })

  it.skipIf(process.platform === 'win32')('runs commands named status and run literally through WT_SUITE_LOCK_CMD in zsh', () => {
    const root = tempRoot('literal-zsh')
    const bin = join(root, 'bin')
    const stub = '#!/bin/sh\nprintf "literal command: %s\\n" "$0"\nexit 7\n'
    writeFileSync(join(root, 'status'), stub)
    writeFileSync(join(root, 'run'), stub)
    chmodSync(join(root, 'status'), 0o755)
    chmodSync(join(root, 'run'), 0o755)
    for (const command of ['status', 'run']) {
      const result = spawnSync('zsh', ['-c', '"$WT_SUITE_LOCK_CMD" "$1"', 'zsh', command], {
        encoding: 'utf8',
        env: { ...process.env, PATH: `${root}${delimiter}${process.env.PATH}`, WT_SUITE_LOCK_CMD: RUNNER, WT_SUITE_LOCK_DIR: bin },
      })
      expect(result.status).toBe(7)
      expect(result.stdout).toContain(`literal command: ${join(root, command)}`)
    }
  })

  it('rejects an unknown subcommand with usage and does not run it', () => {
    const root = tempRoot('unknown-subcommand')
    const marker = join(root, 'statsu-ran')
    const result = cli(['statsu', process.execPath, '-e', `require('fs').writeFileSync(${JSON.stringify(marker)}, 'ran')`], root)
    expect(result.status).toBe(2)
    expect(result.stderr).toContain('unknown subcommand: statsu')
    expect(result.stderr).toContain('Usage:')
    expect(existsSync(marker)).toBe(false)
  })
})

describe('spawn shell decision (Windows shims only)', () => {
  // The 0.182.0 tag run went red on windows-latest with `expected 1 to be +0` on both CLI run tests:
  // a blanket `shell: true` sent `node -e 'process.stdout.write("ran")'` through cmd.exe, which
  // re-parsed the quotes. These lock the DECISION, so they fail on any platform when it regresses.
  it('never asks for a shell off Windows, whatever the executable', () => {
    for (const platform of ['linux', 'darwin'] as const) {
      expect(spawnNeedsShell('pnpm.cmd', { platform })).toBe(false)
      expect(spawnNeedsShell('pnpm', { platform })).toBe(false)
      expect(spawnNeedsShell(process.execPath, { platform })).toBe(false)
    }
  })

  it('asks for a shell on Windows only for a .cmd or .bat shim', () => {
    const platform = 'win32' as const
    expect(spawnNeedsShell('pnpm.cmd', { platform })).toBe(true)
    expect(spawnNeedsShell('C:\\tools\\opencode.CMD', { platform })).toBe(true)
    expect(spawnNeedsShell('run.bat', { platform })).toBe(true)
    expect(spawnNeedsShell('node.exe', { platform })).toBe(false)
    expect(spawnNeedsShell('C:\\Program Files\\nodejs\\node.exe', { platform })).toBe(false)
    expect(spawnNeedsShell('C:\\tools\\runner.mjs', { platform })).toBe(false)
  })

  it('resolves a bare Windows name through PATHEXT and shells only when it lands on a shim', () => {
    const platform = 'win32' as const
    expect(spawnNeedsShell('opencode', { platform, resolve: () => 'C:\\npm\\opencode.cmd' })).toBe(true)
    expect(spawnNeedsShell('node', { platform, resolve: () => 'C:\\nodejs\\node.exe' })).toBe(false)
    // Unresolvable: no shell, so spawn reports its own ENOENT instead of cmd.exe swallowing it.
    expect(spawnNeedsShell('nowhere', { platform, resolve: () => null })).toBe(false)
  })

  it('reads PATH and PATHEXT in order when resolving a bare name', () => {
    const seen: string[] = []
    const needsShell = spawnNeedsShell('tool', {
      platform: 'win32',
      env: { PATH: ['/a', '/b'].join(delimiter), PATHEXT: '.EXE;.CMD' },
      exists: (candidate: string) => {
        seen.push(candidate)
        return candidate === join('/b', 'tool.CMD')
      },
    })
    expect(needsShell).toBe(true)
    expect(seen[0]).toBe(join('/a', 'tool.EXE'))
    expect(seen.length).toBeGreaterThan(1)
  })

  it('resolves an extensionless Windows path against PATHEXT', () => {
    const seen: string[] = []
    const needsShell = spawnNeedsShell('C:\\tools\\opencode', {
      platform: 'win32',
      env: { PATHEXT: '.EXE;.CMD' },
      exists: (candidate: string) => { seen.push(candidate); return candidate.endsWith('.CMD') },
    })
    expect(needsShell).toBe(true)
    expect(seen).toEqual(['C:\\tools\\opencode.EXE', 'C:\\tools\\opencode.CMD'])
  })

  it('refuses Windows shim arguments that cmd.exe would re-parse', () => {
    expect(windowsShimArgumentRefusal(['C:\\tools\\tool.cmd', 'safe & whoami'], { platform: 'win32' })).toContain('unsafe Windows shim argument')
    expect(windowsShimArgumentRefusal(['C:\\tools\\tool.bat', 'say "hello"'], { platform: 'win32' })).toContain('unsafe Windows shim argument')
    expect(windowsShimArgumentRefusal(['C:\\tools\\tool.cmd', '--reporter=dot'], { platform: 'win32' })).toBeNull()
  })

  it('runs a command whose arguments carry quotes, through the lock, exit 0', () => {
    const root = tempRoot('quoted')
    const result = cli(['run', '--', process.execPath, '-e', 'process.stdout.write("quoted ok")'], root)
    expect(result.status).toBe(0)
    expect(result.stdout).toContain('quoted ok')
  })
})
