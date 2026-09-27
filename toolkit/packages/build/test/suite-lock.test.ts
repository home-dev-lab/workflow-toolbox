import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { acquireSuiteLock, formatSuiteLockHolder, readSuiteLock, releaseSuiteLock, spawnNeedsShell, windowsShimArgumentRefusal } from '../../../../plugin/bin/lib/suite-lock.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const CLI = join(ROOT, 'plugin/bin/wt-suite-lock.mjs')
const RUNNER = join(ROOT, 'plugin/bin/wt-suite-lock-run.mjs')
const roots: string[] = []
// Same probe as wt-lane-launcher.test.ts: the ubuntu-latest GitHub runner in cross-os run
// 36238137992 had no working zsh, so an unconditional spawn returned status: null (spawn error,
// never a real exit code) — `expected null to be 7`. Gate on the same real-zsh probe and name why.
const ZSH_WORKS = process.platform !== 'win32' && spawnSync('zsh', ['--version'], { stdio: 'ignore' }).status === 0

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

function runner(args: string[], root: string, extraEnv: NodeJS.ProcessEnv = {}) {
  return spawnSync(process.execPath, [RUNNER, ...args], {
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

// A waiter process driven through the library, so each one can be given its own poll interval: the
// starvation needs a slow poller (asleep between polls when the lock is released) and fast arrivals.
const LIB_URL = new URL('../../../../plugin/bin/lib/suite-lock.mjs', import.meta.url).href
const WAITER_SCRIPT = `
import { appendFileSync } from 'node:fs'
import { acquireSuiteLock, releaseSuiteLock } from ${JSON.stringify(LIB_URL)}
const cfg = JSON.parse(process.argv[1])
let lease
try {
  lease = await acquireSuiteLock({ root: cfg.root, pollMs: cfg.pollMs, noticeMs: 60000, waitS: cfg.waitS, argv: [cfg.name], onWait: (line) => process.stdout.write(line + '\\n') })
} catch (error) {
  appendFileSync(cfg.order, 'TIMEOUT-' + cfg.name + '\\n')
  process.exit(75)
}
appendFileSync(cfg.order, cfg.name + '\\n')
await new Promise((resolve) => setTimeout(resolve, cfg.holdMs))
releaseSuiteLock(lease)
`

interface Waiter { child: ReturnType<typeof spawn>, stdout: () => string, done: Promise<number | null> }

function startWaiter(root: string, order: string, name: string, pollMs: number, holdMs: number, waitS = 30): Waiter {
  const child = spawn(process.execPath, ['--input-type=module', '-e', WAITER_SCRIPT, JSON.stringify({ root, order, name, pollMs, holdMs, waitS })], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let stdout = ''
  child.stdout!.on('data', (chunk) => { stdout += String(chunk) })
  return { child, stdout: () => stdout, done: new Promise((resolve) => child.once('exit', resolve)) }
}

const readOrder = (order: string) => (existsSync(order) ? readFileSync(order, 'utf8').split('\n').filter(Boolean) : [])
const queueRecords = (root: string) => (existsSync(join(root, 'queue.d')) ? readdirSync(join(root, 'queue.d')).filter((name) => name.endsWith('.json')) : [])

describe('suite lock FIFO queue (card 1873075570439357968)', () => {
  // Red on the "first poller wins" lock: the oldest waiter polls every second, the arrivals every
  // 10 ms, so each release went to an arrival and the oldest waiter ran last.
  it('gives the lock to the OLDEST waiter while new arrivals keep coming, and prints each position', async () => {
    const root = tempRoot('fifo')
    const order = join(root, 'order.log')
    const holder = startWaiter(root, order, 'H', 10, 2500)
    await waitFor(() => readOrder(order).includes('H'), 5000)
    const oldest = startWaiter(root, order, 'W1', 1000, 200)
    await waitFor(() => oldest.stdout().includes('waiting for suite lock'), 5000)
    const second = startWaiter(root, order, 'A2', 10, 400)
    await waitFor(() => second.stdout().includes('waiting for suite lock'), 5000)
    const third = startWaiter(root, order, 'A3', 10, 400)
    await waitFor(() => third.stdout().includes('waiting for suite lock'), 5000)
    expect(readOrder(order), 'the holder must still hold when the last arrival queues').toEqual(['H'])
    for (const waiter of [holder, oldest, second, third]) expect(await waiter.done).toBe(0)
    expect(readOrder(order)).toEqual(['H', 'W1', 'A2', 'A3'])
    expect(oldest.stdout()).toMatch(/waiting for suite lock: position 1 of 1, holder pid \d+ \(H\) since \d\d:\d\d/)
    expect(third.stdout()).toMatch(/waiting for suite lock: position 3 of 3, holder pid \d+ \(H\) since \d\d:\d\d/)
    expect(queueRecords(root)).toEqual([])
  }, 20_000)

  it('does not let a waiter killed mid-queue block the waiters behind it', async () => {
    const root = tempRoot('fifo-crash')
    const order = join(root, 'order.log')
    const holder = startWaiter(root, order, 'H', 10, 1500)
    await waitFor(() => readOrder(order).includes('H'), 5000)
    const killed = startWaiter(root, order, 'K', 50, 100)
    await waitFor(() => killed.stdout().includes('waiting for suite lock'), 5000)
    const behind = startWaiter(root, order, 'W', 50, 100, 6)
    await waitFor(() => behind.stdout().includes('position 2 of 2'), 5000)
    killed.child.kill('SIGKILL')
    await killed.done
    expect(await holder.done).toBe(0)
    expect(await behind.done).toBe(0)
    expect(readOrder(order)).toEqual(['H', 'W'])
    expect(queueRecords(root)).toEqual([])
  }, 20_000)
})

describe('suite lock queue tickets', () => {
  function seedTicket(root: string, number: number, record: unknown, ageMs = 0) {
    const queue = join(root, 'queue.d')
    mkdirSync(queue, { recursive: true })
    const base = join(queue, String(number).padStart(16, '0'))
    writeFileSync(`${base}.ticket`, '')
    writeFileSync(`${base}.json`, typeof record === 'string' ? record : JSON.stringify(record))
    if (ageMs > 0) {
      const then = new Date(Date.now() - ageMs)
      utimesSync(`${base}.json`, then, then)
    }
    return `${base}.json`
  }
  const liveRecord = (extra: Record<string, unknown> = {}) => ({ pid: process.pid, argv: ['x'], cwd: '/', startedAt: new Date().toISOString(), platform: process.platform, pidNamespace: null, startTime: null, ...extra })
  const timesOut = (options: Record<string, unknown>) => acquireSuiteLock({ waitS: 0.2, pollMs: 10, insideSandbox: false, ...options }).then(
    (lease: { holder: unknown }) => { releaseSuiteLock(lease); return 'acquired' },
    (error: { code?: string }) => error.code,
  )

  // A launcher from an older release takes no ticket; the head of the queue out-polls it by polling
  // at 100 ms whatever its own interval, which also bounds the hand-over after a release.
  it('polls fast at the head of the queue, so a release is picked up within a fraction of its poll interval', async () => {
    const root = tempRoot('ticket-head')
    const blocker = await acquireSuiteLock({ root })
    let acquiredAt = 0
    const waiting = acquireSuiteLock({ root, pollMs: 5000, waitS: 20 }).then((lease: unknown) => { acquiredAt = Date.now(); return lease })
    await new Promise((resolve) => setTimeout(resolve, 150))
    const releasedAt = Date.now()
    releaseSuiteLock(blocker)
    releaseSuiteLock(await waiting)
    expect(acquiredAt - releasedAt).toBeLessThan(1500)
  }, 10_000)

  it('waits behind a live ticket even while the lock itself is free', async () => {
    const root = tempRoot('ticket-live')
    seedTicket(root, 1, liveRecord())
    expect(await timesOut({ root })).toBe('WT_SUITE_LOCK_TIMEOUT')
  })

  it('reclaims a ticket whose pid is dead or reused, with the holder rule', async () => {
    const dead = tempRoot('ticket-dead')
    const deadFile = seedTicket(dead, 1, liveRecord({ pid: 2_147_483_647 }))
    expect(await timesOut({ root: dead })).toBe('acquired')
    expect(existsSync(deadFile)).toBe(false)
    const reused = tempRoot('ticket-reused')
    seedTicket(reused, 1, liveRecord({ startTime: 111, pidNamespace: 'pid:[4026531836]' }))
    const view = { root: reused, pidNamespace: 'pid:[4026531836]', insideSandbox: false, platform: 'linux' }
    expect(await timesOut({ ...view, processStartTime: () => 111 })).toBe('WT_SUITE_LOCK_TIMEOUT')
    expect(await timesOut({ ...view, processStartTime: () => 222 })).toBe('acquired')
  })

  it('judges a ticket from another PID namespace like the holder: by its namespace from the host, by its heartbeat inside a sandbox', async () => {
    const host = tempRoot('ticket-host')
    seedTicket(host, 1, liveRecord({ pid: 7, pidNamespace: 'pid:[4026532999]' }))
    const hostView = { root: host, pidNamespace: 'pid:[4026531836]', insideSandbox: false }
    expect(await timesOut({ ...hostView, namespaceHasProcesses: () => true })).toBe('WT_SUITE_LOCK_TIMEOUT')
    expect(await timesOut({ ...hostView, namespaceHasProcesses: () => false })).toBe('acquired')
    // Inside a sandbox the host waiter is invisible: its ticket lives while its heartbeat does, and is
    // reclaimed after min(staleS, waitS) of silence, the holder's own bound.
    const sandboxView = { pidNamespace: 'pid:[4026532999]', insideSandbox: true, namespaceHasProcesses: () => false, waitS: 1, staleS: 60 }
    const fresh = tempRoot('ticket-sandbox-fresh')
    const beating = seedTicket(fresh, 1, liveRecord({ pid: 7, pidNamespace: 'pid:[4026531836]' }))
    const heartbeat = setInterval(() => { const now = new Date(); utimesSync(beating, now, now) }, 50)
    try {
      expect(await timesOut({ root: fresh, ...sandboxView })).toBe('WT_SUITE_LOCK_TIMEOUT')
    } finally { clearInterval(heartbeat) }
    const silent = tempRoot('ticket-sandbox-silent')
    seedTicket(silent, 1, liveRecord({ pid: 7, pidNamespace: 'pid:[4026531836]' }), 3_600_000)
    expect(await timesOut({ root: silent, ...sandboxView })).toBe('acquired')
  })

  // A ticket heartbeats and the holder does not, so a ticket's age bound is its silence (at least two
  // minutes), not the holder's 45-minute/3-hour bounds: a recycled Windows PID or an invisible host
  // waiter cannot hold the queue for hours.
  it('reclaims a ticket silent for minutes where its PID cannot prove it dead, and keeps a beating one', async () => {
    const windows = { platform: 'win32', insideSandbox: false, pidNamespace: null }
    const recycled = tempRoot('ticket-win-recycled')
    seedTicket(recycled, 1, liveRecord({ platform: 'win32' }), 180_000)
    expect(await timesOut({ root: recycled, ...windows, waitS: 5 })).toBe('acquired')
    const beating = tempRoot('ticket-win-beating')
    seedTicket(beating, 1, liveRecord({ platform: 'win32' }), 10_000)
    expect(await timesOut({ root: beating, ...windows })).toBe('WT_SUITE_LOCK_TIMEOUT')
    const hostWaiter = tempRoot('ticket-sandbox-silent-minutes')
    seedTicket(hostWaiter, 1, liveRecord({ pid: 7, pidNamespace: 'pid:[4026531836]' }), 180_000)
    // waitS 600: the holder's own sandbox bound, min(staleS, waitS), would not reclaim it for ten minutes.
    expect(await timesOut({ root: hostWaiter, pidNamespace: 'pid:[4026532999]', insideSandbox: true, waitS: 600 })).toBe('acquired')
  }, 15_000)

  it('keeps an unreadable ticket for a grace period, then reclaims it', async () => {
    const young = tempRoot('ticket-unreadable-young')
    seedTicket(young, 1, '')
    expect(await timesOut({ root: young })).toBe('WT_SUITE_LOCK_TIMEOUT')
    const old = tempRoot('ticket-unreadable-old')
    seedTicket(old, 1, '', 60_000)
    expect(await timesOut({ root: old })).toBe('acquired')
  })

  it('numbers past every allocated marker, prunes old markers, and restores a live waiter\'s removed record under its number', async () => {
    const root = tempRoot('ticket-numbering')
    const queue = join(root, 'queue.d')
    mkdirSync(queue, { recursive: true })
    for (const number of [1, 300]) writeFileSync(join(queue, `${String(number).padStart(16, '0')}.ticket`), '')
    const blocker = await acquireSuiteLock({ root })
    let acquired = false
    const waiting = acquireSuiteLock({ root, pollMs: 10, waitS: 5 }).then((lease: unknown) => { acquired = true; return lease })
    // The blocker took 301 (past marker 300, never the freed 2), so this waiter holds 302.
    const mine = join(queue, `${String(302).padStart(16, '0')}.json`)
    await waitFor(() => existsSync(mine))
    expect(existsSync(join(queue, `${String(1).padStart(16, '0')}.ticket`)), 'a marker 256 below the new ticket is pruned').toBe(false)
    rmSync(mine)
    await waitFor(() => existsSync(mine))
    expect(acquired).toBe(false)
    releaseSuiteLock(blocker)
    releaseSuiteLock(await waiting)
    expect(existsSync(mine)).toBe(false)
  })
})

describe('holder display', () => {
  it('replaces control characters, caps the command, and never prints a non-integer pid', () => {
    const line = formatSuiteLockHolder({ pid: '1\nforged line', argv: ['pnpm\u001b[31m', `test\r\n${'x'.repeat(200)}`], startedAt: 'nope' })
    expect(line).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/)
    expect(line).toContain('holder pid unknown (pnpm?[31m test??')
    expect(line).toMatch(/\.\.\.\) since unknown time$/)
    expect(line.length).toBeLessThan(140)
    expect(formatSuiteLockHolder({ pid: 42, argv: ['a\u202eb'], startedAt: 'nope' })).toBe('holder pid 42 (a?b) since unknown time')
    expect(formatSuiteLockHolder('string holder')).toBe('holder unknown')
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
    expect(second.stderr()).toMatch(/waiting for suite lock: position 1 of 1, holder pid \d+ \(.+\) since \d\d:\d\d/)
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

  it.skipIf(!ZSH_WORKS)('runs commands named status and run literally through WT_SUITE_LOCK_CMD in zsh (skips: zsh unavailable)', () => {
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
      expect(result.error, 'zsh spawn itself failed rather than the child exiting').toBeUndefined()
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

describe('wt-suite-lock-run runner', () => {
  it('runs the given argv verbatim under the lock', () => {
    const root = tempRoot('runner-verbatim')
    const result = runner([process.execPath, '-e', 'process.stdout.write("ran")'], root)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('ran')
  })

  // An adopted `~/.claude/scripts/wt-lane.mjs` predating this runner still builds
  // `node <suiteLockCli> run --` itself (card 1872232864, review r3). With WT_SUITE_LOCK_CMD now
  // naming this dedicated runner (which always forwards ['run', '--', ...argv] on its own), that
  // older template doubles the prefix into `run -- run -- <command>` and the runner's own `run`
  // subcommand tries to spawn a program literally named `run`. Strip one leading `run --` (or a
  // bare `--`) so both the old and the new launcher template work.
  it('strips one leading "run --" from an older adopted launcher template without doubling it', () => {
    const root = tempRoot('runner-compat-run')
    const result = runner(['run', '--', process.execPath, '-e', 'process.stdout.write("ran")'], root)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('ran')
  })

  it('strips a single leading "--" the same way', () => {
    const root = tempRoot('runner-compat-dashes')
    const result = runner(['--', process.execPath, '-e', 'process.stdout.write("ran")'], root)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe('ran')
  })

  it('takes the suite lock itself while the child runs, and a second runner waits for it', async () => {
    const root = tempRoot('runner-takes-lock')
    const child = spawn(process.execPath, [RUNNER, process.execPath, '-e', 'setTimeout(() => {}, 1500)'], {
      env: { ...process.env, WT_SUITE_LOCK_DIR: root },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    await waitFor(() => existsSync(join(root, 'lock.d', 'holder.json')))
    const holder = JSON.parse(readFileSync(join(root, 'lock.d', 'holder.json'), 'utf8'))
    expect(holder.pid).toBe(child.pid)
    const statusWhileHeld = cli(['status'], root)
    expect(statusWhileHeld.stdout).toContain('suite lock held')
    const second = runner([process.execPath, '-e', 'process.stdout.write("second ran")'], root)
    expect(second.stderr).toMatch(/waiting for suite lock: position 1 of 1, holder pid \d+ /)
    expect(second.stdout).toBe('second ran')
    await new Promise((resolve) => child.once('exit', resolve))
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

interface QueueModule {
  takeTicket: (queueDir: string, record: unknown, seams?: { list?: (queueDir: string) => { markers: number[], records: number[] } }) => number
}
const queueModule = (await import(new URL('../../../../plugin/bin/lib/host/suite-lock-queue.mjs', import.meta.url).href)) as QueueModule

// Round 2 (review of the first FIFO commit): each case is red on that commit.
describe('suite lock queue — round 2', () => {
  const pad = (number: number) => String(number).padStart(16, '0')
  function seed(root: string, number: number, record: unknown, ageMs = 0, marker = true) {
    const queue = join(root, 'queue.d')
    mkdirSync(queue, { recursive: true })
    if (marker) writeFileSync(join(queue, `${pad(number)}.ticket`), '')
    const file = join(queue, `${pad(number)}.json`)
    writeFileSync(file, JSON.stringify(record))
    if (ageMs > 0) { const then = new Date(Date.now() - ageMs); utimesSync(file, then, then) }
    return file
  }
  const record = (extra: Record<string, unknown> = {}) => ({ pid: process.pid, argv: ['x'], cwd: '/', startedAt: new Date().toISOString(), platform: process.platform, pidNamespace: null, startTime: null, ...extra })
  const attempt = (options: Record<string, unknown>) => acquireSuiteLock({ waitS: 0.2, pollMs: 10, insideSandbox: false, ...options }).then(
    (lease: { holder: unknown }) => { releaseSuiteLock(lease); return 'acquired' },
    (error: { code?: string }) => error.code,
  )
  const HOST = 'pid:[4026531836]'
  const SANDBOX = 'pid:[4026532999]'

  // F1: a populated namespace proves nothing about the ticket's owner; silence past the bound wins.
  it('reclaims a silent foreign-namespace ticket from the host even while its namespace is populated', async () => {
    const root = tempRoot('r2-f1')
    seed(root, 1, record({ pid: 7, pidNamespace: SANDBOX }), 180_000)
    expect(await attempt({ root, pidNamespace: HOST, namespaceHasProcesses: () => true })).toBe('acquired')
  })

  // F3: the caller's --wait-s / --stale-s never shorten another waiter's grace below the fixed floor.
  it('keeps a recently beating ticket whatever the newcomer\'s wait or stale bound, in every view', async () => {
    const sandboxView = tempRoot('r2-f3-sandbox')
    seed(sandboxView, 1, record({ pid: 7, pidNamespace: HOST }), 500)
    expect(await attempt({ root: sandboxView, pidNamespace: SANDBOX, insideSandbox: true, waitS: 0.2 })).toBe('WT_SUITE_LOCK_TIMEOUT')
    const windows = tempRoot('r2-f3-windows')
    seed(windows, 1, record({ platform: 'win32' }), 10_000)
    expect(await attempt({ root: windows, platform: 'win32', pidNamespace: null, staleS: 1 })).toBe('WT_SUITE_LOCK_TIMEOUT')
  })

  // F5: a lost race on <n>.json means the number is not mine.
  it('never returns a number whose record another waiter already published', () => {
    const root = tempRoot('r2-f5-owner')
    const queue = join(root, 'queue.d')
    const theirs = seed(root, 1, record({ argv: ['theirs'] }), 0, false)
    let stale = true
    const list = (dir: string) => {
      if (stale) { stale = false; return { markers: [], records: [] } }
      const names = readdirSync(dir)
      const numbers = (suffix: string) => names.filter((name) => name.endsWith(suffix)).map((name) => Number(name.slice(0, 16)))
      return { markers: numbers('.ticket'), records: numbers('.json') }
    }
    const mine = queueModule.takeTicket(queue, record({ argv: ['mine'] }), { list })
    expect(mine).not.toBe(1)
    expect(JSON.parse(readFileSync(theirs, 'utf8')).argv).toEqual(['theirs'])
    expect(JSON.parse(readFileSync(join(queue, `${pad(mine)}.json`), 'utf8')).argv).toEqual(['mine'])
  })

  it('prunes allocation markers only below the lowest live ticket', () => {
    const root = tempRoot('r2-f5-prune')
    const queue = join(root, 'queue.d')
    seed(root, 1, record())
    writeFileSync(join(queue, `${pad(300)}.ticket`), '')
    expect(queueModule.takeTicket(queue, record())).toBe(301)
    expect(existsSync(join(queue, `${pad(1)}.ticket`)), 'marker of a live ticket survives').toBe(true)
  })

  // F8: an abandoned reclaim.d must neither spin the loop past its wait nor block reclaim forever.
  it('times out on schedule behind an abandoned reclaim.d, and reclaims one older than its bound', async () => {
    const seedStaleHolder = (root: string, reclaimAgeMs: number) => {
      mkdirSync(join(root, 'lock.d'), { recursive: true })
      writeFileSync(join(root, 'lock.d', 'holder.json'), JSON.stringify({ ...record({ pid: 2_147_483_647 }) }))
      mkdirSync(join(root, 'reclaim.d'))
      if (reclaimAgeMs > 0) { const then = new Date(Date.now() - reclaimAgeMs); utimesSync(join(root, 'reclaim.d'), then, then) }
    }
    const fresh = tempRoot('r2-f8-fresh')
    seedStaleHolder(fresh, 0)
    const started = Date.now()
    expect(await attempt({ root: fresh })).toBe('WT_SUITE_LOCK_TIMEOUT')
    expect(Date.now() - started).toBeLessThan(2000)
    const abandoned = tempRoot('r2-f8-abandoned')
    seedStaleHolder(abandoned, 120_000)
    expect(await attempt({ root: abandoned })).toBe('acquired')
  }, 10_000)
})
