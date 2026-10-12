import { spawn, spawnSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, unlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { beforeEach, describe, expect, it } from 'vitest'
import { laneSandboxContext, noteInsideLaneSandbox, skipInsideLaneSandbox } from '../../../test-support/lane-sandbox-context.js'
// @ts-expect-error ESM runtime module
import { LaneSandboxRefusal, trustedSystemExecutable } from '../../../../plugin/bin/lib/host/lane-sandbox.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { detectOrphanWatchers, terminateOrphanWatchers } from '../../../../plugin/bin/lib/lane-watcher-orphans.mjs'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { classifyIdleHelper, IDLE_HELPER_SAFE_TO_STOP_SECONDS } from '../../../../plugin/bin/lib/resolved-binary.mjs'
// @ts-expect-error ESM runtime module
import { laneHostDir } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'

const WATCHER = resolve(__dirname, '../../../../plugin/bin/wt-lane-orphan-watch.mjs')
const LIB = resolve(__dirname, '../../../../plugin/bin/lib')
const load = async <T>(file: string): Promise<T> => (await import(pathToFileURL(join(LIB, file)).href)) as T
const { isLiveSandboxedLane, laneDescendantPids } = await load<{ isLiveSandboxedLane: (record: Record<string, unknown>, verdict: { status: string }) => boolean, laneDescendantPids: (roots: number[], rows: Array<{ pid: number, ppid?: number }>) => Set<number> }>('lane-live-scan.mjs')
const { inspectProcess } = await load<{ inspectProcess: (pid: number | undefined) => { argv: string[], startTime: number } }>('lane-supervisor-core.mjs')
const sandbox = await load<{ resolveLaneSandbox: (request: Record<string, unknown>) => { kind: string, line: string, wrap: (bin: string, args: string[]) => [string, string[]], dispose: () => void } }>('host/lane-sandbox.mjs')
const BWRAP_WORKS = process.platform === 'linux' && spawnSync('bwrap', ['--ro-bind', '/', '/', '--unshare-all', '--proc', '/proc', '--', 'true'], { stdio: 'ignore' }).status === 0 && spawnSync('sh', ['-c', 'command -v socat'], { stdio: 'ignore' }).status === 0
const laneContext = laneSandboxContext()
if (!BWRAP_WORKS) noteInsideLaneSandbox('wt-lane-orphan-watch.test.ts > collection-time skipIf(!BWRAP_WORKS)', 'nested bwrap or socat is unavailable; two sandbox descendant cases omitted', laneContext)
function missingTrustedBwrap(): string | null {
  if (!laneContext.inside) return null
  try { trustedSystemExecutable('bwrap', process.env.PATH); return null } catch (error) {
    if (error instanceof LaneSandboxRefusal) return (error as Error).message
    throw error
  }
}
const bwrapRefusal = missingTrustedBwrap()
const sandboxResolverTests = new Set([
  'attributes a live sandboxed lane through its bwrap descendants and still warns on an unowned opencode',
  'stays silent on every process of a record-less sandboxed call whose creator is alive',
])
beforeEach((ctx) => {
  if (sandboxResolverTests.has(ctx.task.name)) skipInsideLaneSandbox(ctx, bwrapRefusal, laneContext)
})

function withTempDir(run: (root: string) => void) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lane-orphan-watch-'))
  try { return run(root) } finally { rmSync(laneHostDir(root), { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }) }
}

async function withTempDirAsync(run: (root: string) => Promise<void>) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-orphan-watch-')))
  try { await run(root) } finally { rmSync(laneHostDir(root), { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }) }
}

// Host PIDs whose command line contains `needle` (read from /proc; Linux-only callers).
function pidsMatching(needle: string): number[] {
  return readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => {
    try { return readFileSync(`/proc/${name}/cmdline`, 'utf8').split('\0').join(' ').includes(needle) ? [Number(name)] : [] } catch { return [] }
  })
}

async function waitFor(read: () => number[], timeoutMs = 10_000, atLeast = 3): Promise<number[]> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const found = read()
    if (found.length >= atLeast) return found
    await new Promise((r) => setTimeout(r, 100))
  }
  return read()
}

function processFixture(procRoot: string, pid: number, { argv, cwd, ppid = 1, startTime = pid }: { argv: string[], cwd: string, ppid?: number, startTime?: number }) {
  const dir = join(procRoot, String(pid))
  mkdirSync(dir)
  writeFileSync(join(dir, 'cmdline'), `${argv.join('\0')}\0`)
  const fields = Array.from({ length: 20 }, () => '0')
  fields[0] = 'S'
  fields[1] = String(ppid)
  fields[19] = String(startTime)
  writeFileSync(join(dir, 'stat'), `${pid} (node) ${fields.join(' ')}\n`)
  symlinkSync(cwd, join(dir, 'cwd'))
}

describe('lane orphan watcher self-detection', () => {
  it('emits once for a helper older than five minutes and not for a live helper at the boundary', () => withTempDir((root) => {
    const fixture = join(root, 'helpers.json')
    writeFileSync(fixture, JSON.stringify([
      { pid: 701, argv: ['/usr/bin/codex', 'app-server'], elapsedMs: 300_001, startTime: 11 },
      { pid: 701, argv: ['/usr/bin/codex', 'app-server'], elapsedMs: 300_001, startTime: 11 },
      { pid: 702, argv: ['/usr/bin/codex', 'app-server'], elapsedMs: 300_000, startTime: 12 },
    ]))

    const result = spawnSync(process.execPath, [WATCHER, '--project', root, '--once'], {
      encoding: 'utf8',
      env: { ...process.env, XDG_STATE_HOME: join(root, 'state'), WT_LANE_WATCH_TEST_HELPERS: fixture },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout.match(/IDLE HELPER safe to stop/g)).toHaveLength(1)
    expect(result.stdout).toContain('pid=701')
    expect(result.stdout).not.toContain('pid=702')
  }))

  it('attributes a slotted lane and emits its decision-needed event', () => withTempDir((root) => {
    const fixture = join(root, 'helpers.json')
    writeFileSync(fixture, '[]')
    const supervision = join(laneHostDir(root), 'supervision-critic-Z')
    mkdirSync(supervision, { recursive: true })
    writeFileSync(join(supervision, 'current.json'), JSON.stringify({ version: 1, runId: '10-20' }))
    writeFileSync(join(supervision, '10-20.json'), JSON.stringify({
      runId: '10-20', state: 'decision-needed', owner: 'session', ownerSessionId: 'slot-owner',
      worktree: root, workerPid: 2_147_483_646, childPid: 2_147_483_647,
      timeoutAt: '2026-09-21T12:00:00.000Z', decisionDueAt: '2026-09-21T12:05:00.000Z',
      defaultDecision: 'extend', workerArgv: [], evidence: {},
    }))

    const result = spawnSync(process.execPath, [WATCHER, '--project', root, '--once'], {
      encoding: 'utf8',
      env: { ...process.env, CLAUDE_CODE_SESSION_ID: 'slot-owner', XDG_STATE_HOME: join(root, 'state'), WT_LANE_WATCH_TEST_HELPERS: fixture },
    })

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('LANE decision-needed:')
    expect(result.stdout).not.toContain('unattributed opencode')
    expect(result.stdout).toContain('--slot \'critic-Z\' --decision extend')
  }))

  it('uses the same strict five-minute boundary for a Windows command line', () => {
    const classify = (ageSeconds: number) => classifyIdleHelper({
      argv: [], command: 'C:\\tools\\codex.exe app-server', ageSeconds, relatedToTask: false,
      thresholdSeconds: IDLE_HELPER_SAFE_TO_STOP_SECONDS,
    })
    expect(classify(300)).toMatchObject({ helper: true, safeToStop: false })
    expect(classify(300.001)).toMatchObject({ helper: true, safeToStop: true })
  })

  it('names and signals only a watcher with deleted cwd and init parent', () => withTempDir((root) => {
    const procRoot = join(root, 'proc')
    mkdirSync(procRoot)
    const watcherArgv = ['/usr/bin/node', '/plugin/bin/wt-lane-orphan-watch.mjs']
    processFixture(procRoot, 101, { argv: watcherArgv, cwd: '/tmp/doomed (deleted)' })
    processFixture(procRoot, 102, { argv: watcherArgv, cwd: '/tmp/live' })
    processFixture(procRoot, 103, { argv: ['/usr/bin/opencode', '--version'], cwd: '/tmp/other (deleted)' })
    processFixture(procRoot, 104, { argv: watcherArgv, cwd: '/tmp/not-reparented (deleted)', ppid: 77 })
    processFixture(procRoot, 105, { argv: watcherArgv, cwd: '/tmp/self (deleted)' })
    const signaled: Array<[number, string]> = []

    const result = terminateOrphanWatchers({ procRoot, platform: 'linux', selfPid: 105, kill: (pid: number, signal: string) => { signaled.push([pid, signal]) } })

    expect(result.status).toBe('known')
    expect(result.orphans.map((row: { pid: number }) => row.pid)).toEqual([101])
    expect(result.reports.map((row: { pid: number }) => row.pid)).toEqual([104])
    expect(result.killed).toEqual([101])
    expect(signaled).toEqual([[101, 'SIGTERM']])
  }))

  it('revalidates identity and both orphan discriminators before signaling the exact pid', () => withTempDir((root) => {
    const procRoot = join(root, 'proc')
    mkdirSync(procRoot)
    processFixture(procRoot, 201, { argv: ['/usr/bin/node', '/plugin/bin/wt-lane-orphan-watch.mjs'], cwd: '/tmp/doomed (deleted)', startTime: 10 })
    const signaled: number[] = []

    const first = detectOrphanWatchers({ procRoot, platform: 'linux', selfPid: 999 })
    writeFileSync(join(procRoot, '201', 'stat'), `201 (node) S 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 11\n`)
    const result = terminateOrphanWatchers({ procRoot, platform: 'linux', selfPid: 999, candidates: first.orphans, kill: (pid: number) => { signaled.push(pid) } })

    expect(result.killed).toEqual([])
    expect(signaled).toEqual([])
  }))

  it('reports a watcher whose cwd cannot be classified instead of signaling it', () => withTempDir((root) => {
    const procRoot = join(root, 'proc')
    mkdirSync(procRoot)
    processFixture(procRoot, 301, { argv: ['/usr/bin/node', '/plugin/bin/wt-lane-orphan-watch.mjs'], cwd: '/tmp/unknown' })
    unlinkSync(join(procRoot, '301', 'cwd'))
    const signaled: number[] = []

    const result = terminateOrphanWatchers({ procRoot, platform: 'linux', selfPid: 999, kill: (pid: number) => { signaled.push(pid) } })

    expect(result.reports).toMatchObject([{ pid: 301, reason: 'cwd unreadable; no signal sent' }])
    expect(signaled).toEqual([])
  }))

  // Round 3, defect 3 (card 1871036638205838753): a sandboxed lane's recorded child is the OUTER
  // bwrap, and its opencode runs as a descendant in a new PID namespace. Real processes, both
  // directions: the sandboxed lane is attributed with no warning; a genuine unowned opencode in the
  // same worktree is still warned about.
  it.skipIf(!BWRAP_WORKS)('attributes a live sandboxed lane through its bwrap descendants and still warns on an unowned opencode', async () => withTempDirAsync(async (root) => {
    const wt = join(root, 'wt'); const bin = join(wt, 'bin'); const fake = join(bin, 'opencode')
    for (const dir of [bin, join(root, 'home'), join(root, 'run'), join(root, 'othertmp'), join(root, 'config')]) mkdirSync(dir, { recursive: true })
    writeFileSync(fake, '#!/bin/sh\nsleep 60\n'); chmodSync(fake, 0o755)
    const plan = sandbox.resolveLaneSandbox({ profile: 'opencode', bin: fake, args: ['run', 'sandboxed', '--dir', wt], cwd: wt, env: { HOME: join(root, 'home'), PATH: process.env.PATH }, runtimeParent: join(root, 'run'), optionEnv: { PATH: process.env.PATH } })
    expect(plan.kind).toBe('bwrap')
    const [command, args] = plan.wrap(fake, ['run', 'sandboxed', '--dir', wt])
    // The recorded child is a wrapper shell, so the bwrap's parent is not the pid its runtime directory
    // names: only the supervision record can attribute this lane (the creator path cannot mask it).
    const lane = spawn('/bin/sh', ['-c', '"$@"; :', 'sh', command, ...args], { cwd: wt, detached: true, stdio: 'ignore' })
    const unowned = spawn('/bin/sh', [fake, 'run', 'unowned', '--dir', wt], { cwd: wt, detached: true, stdio: 'ignore' })
    // An UNSANDBOXED lane whose child starts a nested opencode run: the nested one is not attributed.
    const plain = spawn('/bin/sh', ['-c', `/bin/sh ${fake} run nested --dir ${wt}; :`], { cwd: wt, detached: true, stdio: 'ignore' })
    try {
      const inner = await waitFor(() => pidsMatching('opencode run sandboxed'))
      // Round 4, LOW 9: never vacuous — outer bwrap, inner bwrap, bootstrap shell and the fake opencode.
      expect(inner.length, `sandboxed lane processes found: ${inner.join(',')}`).toBeGreaterThanOrEqual(3)
      const nested = (await waitFor(() => pidsMatching('opencode run nested'), 10_000, 2)).filter((pid) => pid !== plain.pid)
      expect(nested.length).toBe(1)
      const child = inspectProcess(lane.pid); const worker = inspectProcess(process.pid); const plainChild = inspectProcess(plain.pid)
      const supervision = join(laneHostDir(wt), 'supervision')
      mkdirSync(supervision, { recursive: true })
      writeFileSync(join(supervision, 'current.json'), JSON.stringify({ version: 1, runId: '11-22' }))
      writeFileSync(join(supervision, '11-22.json'), JSON.stringify({
        version: 1, runId: '11-22', state: 'running', owner: 'session', ownerSessionId: 'another-session', worktree: wt, log: join(wt, '.lane', 'run.log'),
        workerPid: process.pid, workerArgv: worker.argv, workerStartTime: worker.startTime,
        childPid: lane.pid, childArgv: child.argv, childStartTime: child.startTime, sandbox: plan.line,
      }))
      writeFileSync(join(supervision, '33-44.json'), JSON.stringify({
        version: 1, runId: '33-44', state: 'running', owner: 'session', ownerSessionId: 'another-session', worktree: wt, log: join(wt, '.lane', 'run2.log'),
        workerPid: process.pid, workerArgv: worker.argv, workerStartTime: worker.startTime,
        childPid: plain.pid, childArgv: plainChild.argv, childStartTime: plainChild.startTime, sandbox: 'lane sandbox: none (disabled by WT_LANE_SANDBOX=off); running with the environment allow-list only',
      }))
      const result = spawnSync(process.execPath, [WATCHER, '--project', wt, '--once'], {
        encoding: 'utf8', timeout: 60_000,
        // TMPDIR moves the watcher's "temp-hosted executable = test fake" exclusion off this fixture.
        env: { ...process.env, TMPDIR: join(root, 'othertmp'), XDG_STATE_HOME: join(root, 'state'), CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_PLUGIN_DATA: '', CLAUDE_CODE_SESSION_ID: 'watcher-session' },
      })
      expect(result.status, result.stderr).toBe(0)
      const warned = [...result.stdout.matchAll(/WARNING: unattributed opencode pid=(\d+)/g)].map((m) => Number(m[1]))
      for (const pid of inner) expect(warned, `sandboxed lane process ${pid} warned: ${result.stdout}`).not.toContain(pid)
      expect(warned).toContain(unowned.pid)
      expect(warned, `nested opencode of an UNSANDBOXED lane must still be warned: ${result.stdout}`).toContain(nested[0])
      expect(warned).not.toContain(plain.pid)
    } finally {
      for (const p of [lane, unowned, plain]) { try { process.kill(-p.pid!, 'SIGKILL') } catch { /* gone */ } }
      plan.dispose()
    }
  }))

  // Round 4, LOW 7: only a LIVE SANDBOXED lane donates its descendants.
  it('isLiveSandboxedLane requires the bwrap launch line AND a live status', () => {
    const bwrap = { sandbox: 'lane sandbox: bwrap (opencode; …)' }
    expect(isLiveSandboxedLane(bwrap, { status: 'running' })).toBe(true)
    expect(isLiveSandboxedLane(bwrap, { status: 'decision-needed' })).toBe(true)
    expect(isLiveSandboxedLane(bwrap, { status: 'worker-gone-child-alive' })).toBe(false)
    expect(isLiveSandboxedLane(bwrap, { status: 'unknown' })).toBe(false)
    expect(isLiveSandboxedLane({ sandbox: 'lane sandbox: none (bubblewrap sandbox is Linux-only)' }, { status: 'running' })).toBe(false)
    expect(isLiveSandboxedLane({}, { status: 'running' })).toBe(false)
  })

  it('laneDescendantPids follows ppid links from verified roots only', () => {
    const rows = [{ pid: 10, ppid: 1 }, { pid: 11, ppid: 10 }, { pid: 12, ppid: 11 }, { pid: 13, ppid: 12 }, { pid: 20, ppid: 1 }, { pid: 21, ppid: 20 }, { pid: 30 }]
    expect([...laneDescendantPids([10], rows)].sort()).toEqual([10, 11, 12, 13])
    expect([...laneDescendantPids([], rows)]).toEqual([])
    expect([...laneDescendantPids([1], rows)]).toEqual([])
  })

  it('returns unavailable rather than zero orphans without Linux procfs', () => {
    expect(detectOrphanWatchers({ platform: 'darwin' })).toEqual({
      status: 'unavailable',
      reason: 'watcher orphan detection unavailable on this platform: /proc required',
      orphans: [],
      reports: [],
    })
  })
})

// A batch launcher (wt-opencode-envelope.mjs) writes no supervision record: each of its opencode calls used
// to be a fresh "unattributed" warning, one wake of the watching session per call. Real processes, both
// directions: a live envelope's calls are silent, an unknown launcher's calls warn ONCE for its tree, and an
// opencode whose launcher is dead is still warned.
describe.skipIf(process.platform !== 'linux')('lane orphan watcher batch-launcher attribution', { timeout: 90_000 }, () => {
  // Polls /proc until `count` processes carrying `needle` are visible, under a 30 s cap (returns as soon as they are).
  const visiblePids = (needle: string, count: number) => waitFor(() => pidsMatching(needle), 30_000, count)
  const LAUNCHER_SOURCE = [
    "import { spawn } from 'node:child_process'",
    'const [fake, wt, label, mode] = process.argv.slice(2)',
    "const call = (n, extra = {}) => spawn('/bin/sh', [fake, 'run', `${label}-${n}`, '--dir', wt], { cwd: wt, stdio: 'ignore', ...extra })",
    "if (mode === 'serial') {",
    "  call(1, { env: { ...process.env, FAKE_SLEEP: '4' } }).once('exit', () => setTimeout(() => call(2), 4000))",
    "} else {",
    "  for (const n of [1, 2]) { const child = call(n, { detached: mode === 'orphan' }); if (mode === 'orphan') child.unref() }",
    '}',
    "if (mode !== 'orphan') setInterval(() => {}, 1000)",
  ].join('\n')

  function runWatcher(root: string, wt: string) {
    const result = spawnSync(process.execPath, [WATCHER, '--project', wt, '--once'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, TMPDIR: join(root, 'othertmp'), XDG_STATE_HOME: join(root, 'state'), CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_PLUGIN_DATA: '', CLAUDE_CODE_SESSION_ID: 'watcher-session' },
    })
    expect(result.status, result.stderr).toBe(0)
    return { stdout: result.stdout, warned: [...result.stdout.matchAll(/WARNING: unattributed opencode pid=(\d+)/g)].map((m) => Number(m[1])) }
  }

  function fixture(root: string) {
    const wt = join(root, 'wt'); const fake = join(wt, 'bin', 'opencode')
    for (const dir of [join(wt, 'bin'), join(root, 'othertmp'), join(root, 'config'), join(root, 'launchers', 'plugin', 'bin')]) mkdirSync(dir, { recursive: true })
    writeFileSync(fake, '#!/bin/sh\nsleep "${FAKE_SLEEP:-60}"\n'); chmodSync(fake, 0o755)
    const envelope = join(root, 'launchers', 'plugin', 'bin', 'wt-opencode-envelope.mjs')
    const other = join(root, 'launchers', 'other-batch.mjs')
    writeFileSync(envelope, LAUNCHER_SOURCE); writeFileSync(other, LAUNCHER_SOURCE)
    return { wt, fake, envelope, other }
  }

  // SIGKILL each pid AND its descendants (the fake's `sleep` would otherwise outlive its shell), by exact pid.
  const childPids = (pid: number) => readdirSync('/proc').filter((name) => /^\d+$/.test(name)).flatMap((name) => {
    try { const stat = readFileSync(`/proc/${name}/stat`, 'utf8'); return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]) === pid ? [Number(name)] : [] } catch { return [] }
  })
  const killAll = (pids: number[]) => {
    const all = new Set<number>(); const pending = [...pids]
    while (pending.length) { const pid = pending.pop()!; if (all.has(pid)) continue; all.add(pid); pending.push(...childPids(pid)) }
    for (const pid of all) { try { process.kill(pid, 'SIGKILL') } catch { /* gone */ } }
  }

  it('stays silent on the opencode calls of a live envelope and warns once per unknown launcher tree', async () => withTempDirAsync(async (root) => {
    const { wt, fake, envelope, other } = fixture(root)
    const env = spawn(process.execPath, [envelope, fake, wt, 'envcall'], { cwd: wt, stdio: 'ignore' })
    const unknown = spawn(process.execPath, [other, fake, wt, 'othercall'], { cwd: wt, stdio: 'ignore' })
    // Control: an opencode started straight from this process is a different tree and warns on its own.
    const direct = spawn('/bin/sh', [fake, 'run', 'directcall', '--dir', wt], { cwd: wt, stdio: 'ignore' })
    const started: number[] = [env.pid!, unknown.pid!, direct.pid!]
    try {
      const envCalls = await visiblePids('opencode run envcall-', 2)
      const otherCalls = await visiblePids('opencode run othercall-', 2)
      started.push(...envCalls, ...otherCalls)
      expect(envCalls.length, 'never vacuous: both envelope calls are running').toBe(2)
      expect(otherCalls.length, 'never vacuous: both unknown-launcher calls are running').toBe(2)
      const { stdout, warned } = runWatcher(root, wt)
      for (const pid of envCalls) expect(warned, `envelope call ${pid} warned: ${stdout}`).not.toContain(pid)
      expect(warned.filter((pid) => otherCalls.includes(pid)), `one warning for the unknown launcher's tree: ${stdout}`).toHaveLength(1)
      expect(warned, `a separate tree keeps its own warning: ${stdout}`).toContain(direct.pid)
    } finally {
      killAll(started.slice(3)); killAll(started.slice(0, 3))
    }
  }))

  // The 10:47 witness: one sandboxed call with no lane record warned four times (outer bwrap, inner bwrap,
  // bootstrap shell, opencode), each command line carrying the opencode call. Its live creator owns it.
  it.skipIf(!BWRAP_WORKS)('stays silent on every process of a record-less sandboxed call whose creator is alive', async () => withTempDirAsync(async (root) => {
    const { wt, fake } = fixture(root)
    for (const dir of [join(root, 'home'), join(root, 'run')]) mkdirSync(dir, { recursive: true })
    const plan = sandbox.resolveLaneSandbox({ profile: 'opencode', bin: fake, args: ['run', 'norecord', '--dir', wt], cwd: wt, env: { HOME: join(root, 'home'), PATH: process.env.PATH }, runtimeParent: join(root, 'run'), optionEnv: { PATH: process.env.PATH } })
    expect(plan.kind).toBe('bwrap')
    const [command, args] = plan.wrap(fake, ['run', 'norecord', '--dir', wt])
    const call = spawn(command, args, { cwd: wt, detached: true, stdio: 'ignore' })
    try {
      const chain = await visiblePids('opencode run norecord', 3)
      expect(chain.length, `never vacuous: wrappers and opencode found: ${chain.join(',')}`).toBeGreaterThanOrEqual(3)
      const { stdout, warned } = runWatcher(root, wt)
      for (const pid of chain) expect(warned, `sandboxed call process ${pid} warned: ${stdout}`).not.toContain(pid)
    } finally {
      try { process.kill(-call.pid!, 'SIGKILL') } catch { /* gone */ }
      plan.dispose()
    }
  }))

  it('warns again for the same launcher once its earlier unattributed call has gone', async () => withTempDirAsync(async (root) => {
    const { wt, fake, other } = fixture(root)
    const watcher = spawn(process.execPath, [WATCHER, '--project', wt, '--poll', '0.5'], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, TMPDIR: join(root, 'othertmp'), XDG_STATE_HOME: join(root, 'state'), CLAUDE_CONFIG_DIR: join(root, 'config'), CLAUDE_PLUGIN_DATA: '', CLAUDE_CODE_SESSION_ID: 'watcher-session' },
    })
    let stdout = ''
    watcher.stdout!.on('data', (chunk) => { stdout += String(chunk) })
    const launcher = spawn(process.execPath, [other, fake, wt, 'serialcall', 'serial'], { cwd: wt, stdio: 'ignore' })
    const seen = new Set<number>()
    const warnedSeen = () => [...stdout.matchAll(/WARNING: unattributed opencode pid=(\d+)/g)].map((m) => Number(m[1])).filter((pid) => seen.has(pid))
    try {
      // Waits on the watcher's own output, never a fixed delay: a slow sweep only makes it wait longer.
      const deadline = Date.now() + 45_000
      while (Date.now() < deadline && warnedSeen().length < 2) {
        for (const pid of pidsMatching('opencode run serialcall-')) seen.add(pid)
        await new Promise((r) => setTimeout(r, 100))
      }
      expect(seen.size, `never vacuous: both serial calls ran: ${[...seen].join(',')}`).toBe(2)
      expect(warnedSeen(), `each episode of the tree warns once: ${stdout}`).toHaveLength(2)
    } finally {
      killAll([...seen]); killAll([launcher.pid!, watcher.pid!])
    }
  }), 90_000)

  it('still warns on an opencode call whose envelope is dead', async () => withTempDirAsync(async (root) => {
    const { wt, fake, envelope } = fixture(root)
    const env = spawnSync(process.execPath, [envelope, fake, wt, 'orphancall', 'orphan'], { cwd: wt, stdio: 'ignore', timeout: 30_000 })
    expect(env.status).toBe(0)
    const orphans = await visiblePids('opencode run orphancall-', 2)
    try {
      expect(orphans.length, 'never vacuous: both orphaned calls are running').toBe(2)
      const { stdout, warned } = runWatcher(root, wt)
      // Both calls are reparented to a reaper: neither may hide behind the other's notice.
      expect(warned.filter((pid) => orphans.includes(pid)).sort(), `every orphan of a dead envelope must warn: ${stdout}`).toEqual([...orphans].sort())
    } finally {
      killAll(orphans)
    }
  }))
})
