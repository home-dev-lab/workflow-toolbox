import { spawn, spawnSync, type ChildProcess } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmodSync, copyFileSync, mkdtempSync, mkdirSync, readFileSync, realpathSync, readdirSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { claimCurrentSupervision, classifyLane, inspectProcess, sameIdentity, supervisionPaths, writeJsonAtomic } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'
// @ts-expect-error runtime .mjs launcher exports its bounded capture helper for provider-fixture coverage.
import { assertLaunchMemory, identifySignalCause, inspectStartedProcess, parse } from '../../../../plugin/bin/wt-lane.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const LAUNCHER = join(ROOT, 'plugin/bin/wt-lane.mjs')
const CONTROL = join(ROOT, 'plugin/bin/wt-lane-control.mjs')
const WATCHER = join(ROOT, 'plugin/bin/wt-lane-orphan-watch.mjs')
const FAKE_OPENCODE = join(ROOT, 'toolkit/packages/build/test/fixtures/fake-opencode.mjs')
const roots: string[] = []
const spawnedWatchers: ChildProcess[] = []
const spawnedChildren: ChildProcess[] = []
const spawnedGroups: number[] = []
const escapeRegex = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const PROCESS_CAPTURE_RETRY_MS = 10
const PROCESS_CAPTURE_SCHEDULING_MARGIN_MS = 100
const DARWIN_PROVIDER_MISS_TTL_MS = 100
afterEach(async () => {
  const children = [...spawnedWatchers.splice(0), ...spawnedChildren.splice(0)]
  const exits = children.filter((child) => child.exitCode === null && child.signalCode === null).map((child) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for test child ${child.pid} to exit`)), 5_000)
    child.once('exit', () => { clearTimeout(timer); resolve() })
    if (child.exitCode !== null || child.signalCode !== null) { clearTimeout(timer); resolve() }
  }))
  for (const child of children) if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  for (const group of spawnedGroups.splice(0)) try { process.kill(-group, 'SIGKILL') } catch {}
  await Promise.all(exits)
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 })
})

function fixture(script: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-launcher-'))); roots.push(root)
  const dir = join(root, 'worktree'); const bin = join(root, 'bin'); const config = join(root, 'config')
  mkdirSync(join(dir, '.lane'), { recursive: true }); mkdirSync(bin); mkdirSync(config)
  writeFileSync(join(dir, 'brief.md'), '# brief\n')
  writeFileSync(join(bin, 'opencode'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(FAKE_OPENCODE)} opencode "$@"\n`)
  writeFileSync(join(bin, 'opencode.cmd'), `@echo off\r\n"${process.execPath}" "${FAKE_OPENCODE}" opencode %*\r\n`)
  writeFileSync(join(bin, 'vm_stat'), '#!/bin/sh\nprintf "Mach Virtual Memory Statistics: (page size of 4096 bytes)\\nPages free: 524288.\\n"\n')
  chmodSync(join(bin, 'opencode'), 0o755)
  chmodSync(join(bin, 'vm_stat'), 0o755)
  writeFileSync(join(config, 'settings.json'), JSON.stringify({ env: { WT_EXECUTOR_LANE_CONSENT: 'true' } }))
  const env: NodeJS.ProcessEnv = { ...process.env, PATH: `${bin}${delimiter}${process.env.PATH}`, CLAUDE_CONFIG_DIR: config, XDG_STATE_HOME: join(root, 'state'), WT_FAKE_OPENCODE_ACTION: script, WT_LANE_MIN_AVAILABLE_MIB: '0' }
  return { root, dir, config, env }
}
function isolateWatcherHostCensus(f: ReturnType<typeof fixture>) {
  const helperFixture = join(f.root, 'helpers.json')
  writeFileSync(helperFixture, '[]\n')
  f.env.WT_LANE_WATCH_TEST_HELPERS = helperFixture
  return helperFixture
}
function run(f: ReturnType<typeof fixture>, extra: string[] = [], model = 'openai/gpt-5.6-luna') {
  return spawnSync(process.execPath, [LAUNCHER, '--dir', f.dir, '--model', model, '--brief', join(f.dir, 'brief.md'), '--allow-no-git', ...extra], { encoding: 'utf8', env: f.env })
}
function waitFor(log: string, ms = 15_000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (existsSync(log) && /EXIT=/.test(readFileSync(log, 'utf8'))) return; spawnSync('sleep', ['0.05']) }
}
function waitForFile(file: string, ms = 15_000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (existsSync(file)) return; spawnSync('sleep', ['0.05']) }
}
function waitForContent(file: string, pattern: RegExp, ms = 30_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    if (existsSync(file) && pattern.test(readFileSync(file, 'utf8'))) return
    spawnSync('sleep', ['0.05'])
  }
  throw new Error(`timed out waiting for ${pattern} in ${file}`)
}
function journalEvents(file: string, event: string) {
  if (!existsSync(file)) return []
  return readFileSync(file, 'utf8').trim().split('\n').filter(Boolean).map((line) => JSON.parse(line)).filter((item) => item.event === event)
}
function lineCount(file: string) {
  return existsSync(file) ? readFileSync(file, 'utf8').split('\n').filter(Boolean).length : 0
}
function waitForLines(file: string, count: number, ms = 30_000) {
  const until = Date.now() + ms
  while (Date.now() < until) { if (lineCount(file) >= count) return; spawnSync('sleep', ['0.05']) }
  throw new Error(`timed out waiting for ${count} lines in ${file}; received ${lineCount(file)}`)
}
function spawnWatcher(args: string[], options: Parameters<typeof spawn>[2]) {
  const watcher = spawn(process.execPath, [WATCHER, ...args], options)
  spawnedWatchers.push(watcher)
  return watcher
}
function spawnChild(command: string, args: string[], options: Parameters<typeof spawn>[2]): ChildProcess {
  const child = spawn(command, args, options)
  spawnedChildren.push(child)
  return child
}
function installDeterministicOrphan(status: string, cwd: string) {
  const state = JSON.parse(readFileSync(status, 'utf8'))
  const worker = { pid: state.workerPid, argv: state.workerArgv, startTime: state.workerStartTime }
  const originalChild = { pid: state.childPid, argv: state.childArgv, startTime: state.childStartTime }
  killIdentity(worker, 'SIGKILL'); waitForIdentityExit(worker)
  const actualOriginal = inspectProcess(originalChild.pid)
  if (sameIdentity(originalChild, actualOriginal)) { killIdentity(originalChild, 'SIGKILL'); waitForIdentityExit(originalChild) }
  const replacement = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd, stdio: 'ignore' })
  const until = Date.now() + 5000
  let child = inspectProcess(replacement.pid!)
  while (!child && Date.now() < until) { spawnSync('sleep', ['0.05']); child = inspectProcess(replacement.pid!) }
  if (!child) throw new Error('replacement orphan identity did not become readable')
  writeFileSync(status, JSON.stringify({ ...state, state: 'abandoned', childPid: child.pid, childArgv: child.argv, childStartTime: child.startTime }))
  return child
}
function installDeterministicGroupedOrphan(status: string, cwd: string) {
  const state = JSON.parse(readFileSync(status, 'utf8'))
  const worker = { pid: state.workerPid, argv: state.workerArgv, startTime: state.workerStartTime }
  const originalChild = { pid: state.childPid, argv: state.childArgv, startTime: state.childStartTime }
  killIdentity(worker, 'SIGKILL'); waitForIdentityExit(worker)
  const actualOriginal = inspectProcess(originalChild.pid)
  if (sameIdentity(originalChild, actualOriginal)) { killIdentity(originalChild, 'SIGKILL'); waitForIdentityExit(originalChild) }
  const childPidFile = join(cwd, '.lane', 'grouped-orphan.pid')
  const script = `const { spawn } = require('node:child_process'); const fs = require('node:fs'); const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' }); fs.writeFileSync(${JSON.stringify(childPidFile)}, String(child.pid)); setInterval(() => {}, 1000)`
  const leader = spawnChild(process.execPath, ['-e', script], { cwd, detached: true, stdio: 'ignore' })
  spawnedGroups.push(leader.pid!)
  waitForFile(childPidFile, 5000)
  const until = Date.now() + 5000
  let leaderIdentity = inspectProcess(leader.pid!)
  let child = inspectProcess(Number(readFileSync(childPidFile, 'utf8')))
  while ((!leaderIdentity || !child) && Date.now() < until) {
    spawnSync('sleep', ['0.05'])
    leaderIdentity = inspectProcess(leader.pid!)
    child = inspectProcess(Number(readFileSync(childPidFile, 'utf8')))
  }
  if (!leaderIdentity || !child || child.groupId !== leaderIdentity.pid) throw new Error('grouped orphan identities did not become readable')
  killIdentity(leaderIdentity, 'SIGKILL'); waitForIdentityExit(leaderIdentity)
  writeFileSync(status, JSON.stringify({ ...state, state: 'abandoned', workerPid: leaderIdentity.pid, workerArgv: leaderIdentity.argv, workerStartTime: leaderIdentity.startTime, childPid: child.pid, childArgv: child.argv, childStartTime: child.startTime }))
  return child
}
function waitForVerdict(status: string, expected: string, ms = 15_000) {
  const until = Date.now() + ms
  let verdict = 'unknown'
  while (Date.now() < until) {
    verdict = classifyLane(JSON.parse(readFileSync(status, 'utf8')), { platform: process.platform }).status
    if (verdict === expected) return
    spawnSync('sleep', ['0.05'])
  }
  const state = JSON.parse(readFileSync(status, 'utf8'))
  const workerActual = inspectProcess(state.workerPid, { platform: process.platform })
  const childActual = inspectProcess(state.childPid, { platform: process.platform })
  const fields = (label: string, recorded: { argv: unknown, startTime: unknown, cwd: unknown }, actual: ReturnType<typeof inspectProcess>) =>
    `${label}.record.argv=${JSON.stringify(recorded.argv)}; ${label}.actual.argv=${JSON.stringify(actual?.argv ?? null)}; ` +
    `${label}.record.startTime=${JSON.stringify(recorded.startTime)}; ${label}.actual.startTime=${JSON.stringify(actual?.startTime ?? null)}; ` +
    `${label}.record.cwd=${JSON.stringify(recorded.cwd)}; ${label}.actual.cwd=${JSON.stringify(actual?.cwd ?? null)}`
  throw new Error(`timed out waiting for ${expected} process verdict; received ${verdict}; ${fields('worker', { argv: state.workerArgv, startTime: state.workerStartTime, cwd: state.workerCwd ?? null }, workerActual)}; ${fields('child', { argv: state.childArgv, startTime: state.childStartTime, cwd: state.childCwd ?? null }, childActual)}; record=${JSON.stringify(state)}`)
}
function killIdentity(expected: { pid: number, argv: string[], startTime?: number, cwd?: string | null } | null, signal: NodeJS.Signals) {
  if (!expected) throw new Error('expected test process identity is gone')
  const actual = inspectProcess(expected.pid)
  expect(sameIdentity({ ...expected, startTime: expected.startTime ?? actual?.startTime }, actual)).toBe(true)
  process.kill(expected.pid, signal)
}
function waitForIdentityExit(expected: { pid: number, argv: string[], startTime?: number }, ms = 30_000) {
  const until = Date.now() + ms
  while (Date.now() < until) {
    const actual = inspectProcess(expected.pid)
    if (!sameIdentity(expected, actual)) return
    spawnSync('sleep', ['0.05'])
  }
  throw new Error(`timed out waiting for owned pid ${expected.pid} to exit`)
}
function currentStateFile(dir: string, ms = 3000) {
  const pointer = join(dir, '.lane', 'supervision', 'current.json')
  waitForFile(pointer, ms)
  const runId = JSON.parse(readFileSync(pointer, 'utf8')).runId
  return join(dir, '.lane', 'supervision', `${runId}.json`)
}
function currentDecisionFile(dir: string) {
  const runId = JSON.parse(readFileSync(join(dir, '.lane', 'supervision', 'current.json'), 'utf8')).runId
  return join(dir, '.lane', 'supervision', `${runId}.decision.json`)
}

describe('wt-lane memory and termination evidence seams', () => {
  it('treats a blank memory-floor environment value as the default', () => {
    const previous = process.env.WT_LANE_MIN_AVAILABLE_MIB
    process.env.WT_LANE_MIN_AVAILABLE_MIB = '  \t '
    try {
      expect(parse(['--dir', '.', '--model', 'test/model', '--brief', 'brief.md']).minAvailableMib).toBe(1024)
    } finally {
      if (previous === undefined) delete process.env.WT_LANE_MIN_AVAILABLE_MIB
      else process.env.WT_LANE_MIN_AVAILABLE_MIB = previous
    }
  })

  it('permits an unavailable memory source only when the configured floor is zero', () => {
    const unavailable = () => ({ mib: null, source: 'available memory on aix', reason: 'unsupported platform' })
    expect(() => assertLaunchMemory(false, 0, unavailable)).not.toThrow()
    expect(() => assertLaunchMemory(false, 1, unavailable)).toThrow('available memory is unknown')
  })

  it('classifies a captured earlyoom journal line for the exact child pid', () => {
    const line = '2026-09-22T11:52:43+0100 host earlyoom[900]: sending SIGTERM to process 4242 uid 1000 "opencode": badness 974, VmRSS 488 MiB'
    const run = (() => ({ status: 0, stdout: `${line}\n` })) as unknown as typeof spawnSync

    expect(identifySignalCause(4242, 'SIGTERM', { platform: 'linux', startedAt: 1_790_079_163_000, run }))
      .toEqual({ signal: 'SIGTERM', cause: 'earlyoom', evidence: line })
  })

  it('classifies kernel OOM evidence after an empty earlyoom journal', () => {
    let calls = 0
    const line = 'Sep 22 11:52:43 host kernel: Out of memory: Killed process 4242 (opencode) total-vm:1234kB'
    const run = (() => ({ status: 0, stdout: ++calls === 1 ? '' : `${line}\n` })) as unknown as typeof spawnSync

    expect(identifySignalCause(4242, 'SIGKILL', { platform: 'linux', run }))
      .toEqual({ signal: 'SIGKILL', cause: 'kernel-oom', evidence: line })
  })

  it('does not blame a lane when its pid is only another number on an OOM journal line', () => {
    const line = '2026-09-22T11:52:43+0100 host earlyoom[4242]: sending SIGTERM to process 9999 uid 1000 "other": badness 974, VmRSS 4242 MiB'
    const run = (() => ({ status: 0, stdout: `${line}\n` })) as unknown as typeof spawnSync

    expect(identifySignalCause(4242, 'SIGTERM', { platform: 'linux', run }))
      .toEqual({ signal: 'SIGTERM', cause: 'unknown' })
  })

  it('reports unknown when journalctl is unavailable or the platform has no journal', () => {
    const unavailable = (() => ({ status: null, error: Object.assign(new Error('missing'), { code: 'ENOENT' }), stdout: '' })) as unknown as typeof spawnSync
    expect(identifySignalCause(4242, 'SIGTERM', { platform: 'linux', run: unavailable })).toEqual({ signal: 'SIGTERM', cause: 'unknown' })
    expect(identifySignalCause(4242, 'SIGTERM', { platform: 'darwin', run: (() => { throw new Error('must not run') }) as unknown as typeof spawnSync })).toEqual({ signal: 'SIGTERM', cause: 'unknown' })
  })
})

describe.skipIf(process.platform === 'win32')('wt-lane detached launcher (requires POSIX process-group signals; Windows process evidence is transcript-tested)', () => {
  it('isolates watcher fixtures from the host process census', () => {
    const f = fixture('exit 0')
    expect(JSON.parse(readFileSync(isolateWatcherHostCensus(f), 'utf8'))).toEqual([])
  })

  it('refuses a stale brief and names the acknowledgement flag and fresh-round remedy', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    const brief = join(f.dir, 'brief.md')
    const old = new Date(Date.now() - 15 * 60_000)
    utimesSync(brief, old, old)

    const result = run(f, ['--max-brief-age', '600'])

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(new RegExp(`^wt-lane: Refused: brief ${escapeRegex(brief)} is stale \\(age=.+; maximum=10m0s\\); refresh or rewrite it for a new round, or add --acknowledge-stale-brief when intentionally resuming this old round\\.\\n$`))
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })

  it('launches an intentionally resumed round when stale-brief acknowledgement is explicit', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    const brief = join(f.dir, 'brief.md')
    const old = new Date(Date.now() - 15 * 60_000)
    utimesSync(brief, old, old)

    const result = run(f, ['--max-brief-age', '600', '--acknowledge-stale-brief'])

    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain(`brief=${brief}\n`)
    expect(result.stdout).toMatch(/brief_age=15m\d+s\n/)
    expect(result.stdout).toContain('brief_heading=# brief\n')
    expect(result.stdout).toContain(`brief_sha256=${createHash('sha256').update('# brief\n').digest('hex')}\n`)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'spawned'), 'utf8')).toBe('spawned')
  })

  it('prints and journals the sha256 of the exact brief bytes the worker obeys', () => {
    const original = '# Original round\nfirst bytes\n'
    const replacement = '# Replacement round\nchanged after detach\n'
    const f = fixture('brief=${2#Read and execute the complete brief at }; brief=${brief%.}; cp "$brief" "$PWD/obeyed.md"')
    const brief = join(f.dir, 'brief.md')
    writeFileSync(brief, original)
    f.env.SLOW_PREFLIGHT_AT_COUNT = '2'

    const result = run(f)
    expect(result.status, result.stderr).toBe(0)
    writeFileSync(brief, replacement)
    waitFor(join(f.dir, '.lane', 'run.log'), 10_000)

    const expectedHash = createHash('sha256').update(original).digest('hex')
    expect(result.stdout).toContain(`brief_sha256=${expectedHash}\n`)
    expect(readFileSync(join(f.dir, 'obeyed.md'), 'utf8')).toBe(original)
    expect(readFileSync(join(f.dir, '.lane', 'run.log'), 'utf8')).toMatch(
      new RegExp(`^LANE_RUN_ID=.+\\nBRIEF_PATH=${escapeRegex(brief)}\\nBRIEF_AGE=.+\\nBRIEF_HEADING=# Original round\\nBRIEF_SHA256=${expectedHash}\\n`),
    )
  }, 15_000)

  it('launches a model in the default lane model allow-list', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    expect(run(f).status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'spawned'), 'utf8')).toBe('spawned')
    expect(JSON.parse(readFileSync(currentStateFile(f.dir), 'utf8')).state).not.toBe('launching')
  })
  it('refuses to launch when available memory is below the configured threshold', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.WT_LANE_MIN_AVAILABLE_MIB = String(Number.MAX_SAFE_INTEGER)

    const result = run(f)

    expect(result.status).toBe(1)
    expect(result.stderr).toMatch(/^wt-lane: Refused: available memory \d+ MiB is below the required \d+ MiB; lower WT_LANE_MIN_AVAILABLE_MIB only after freeing or deliberately budgeting memory\.\n$/)
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it.each(['google/gemini-3.6-flash', 'openai/gpt-5.6-sol-fast'])('refuses unlisted model %s before spawn', (model) => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    const res = run(f, [], model)
    expect(res.status).toBe(1)
    expect(res.stderr).toBe('wt-lane: Refused: model ' + model + ' is not in the lane model allow-list (openai/gpt-5.6-luna, openai/gpt-5.6-terra, openai/gpt-5.6-sol, openai/gpt-6-astra); set WT_LANE_MODELS to the full list to allow (it replaces the default).\n')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it('honours a comma- or whitespace-separated WT_LANE_MODELS override with exact matching', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.WT_LANE_MODELS = 'test/one, google/gemini-3.6-flash\ntest/two'
    expect(run(f, [], 'openai/gpt-5.6-luna').status).toBe(1)
    expect(run(f, [], 'google/gemini-3.6-flash').status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'spawned'), 'utf8')).toBe('spawned')
  })
  it('returns immediately, leaves the worker alive, closes stdin, and writes EXIT=0', () => {
    const f = fixture('IFS= read -r x; test -z "$x"; sleep 0.2; echo done')
    const res = run(f); const log = join(f.dir, '.lane', 'run.log')
    expect(res.status).toBe(0); expect(res.stdout).toMatch(/pid=\d+\nrun=\d+-\d+\nlog=/)
     const pid = Number(/pid=(\d+)/.exec(res.stdout)?.[1]); expect(() => process.kill(pid, 0)).not.toThrow()
     expect(readFileSync(join(f.dir, '.lane', 'pid'), 'utf8').trim()).toBe(String(pid))
    waitFor(log); expect(readFileSync(log, 'utf8')).toMatch(/EXIT=0\n$/)
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    waitForContent(journal, /"event":"terminated"/)
    expect(journalEvents(journal, 'terminated')).toHaveLength(1)
  })
  it('records an externally signaled child as cause unknown instead of a timeout', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const result = run(f, ['--timeout', '60'])
    expect(result.status, result.stderr).toBe(0)
    const status = currentStateFile(f.dir)
    waitForContent(status, /"state": "running"/)
    const child = JSON.parse(readFileSync(status, 'utf8')).childPid

    process.kill(child, 'SIGTERM')
    waitFor(join(f.dir, '.lane', 'run.log'))

    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({
      state: 'exited',
      exit: 143,
      killedBy: { signal: 'SIGTERM', cause: 'unknown' },
    })
    expect(readFileSync(join(f.dir, '.lane', 'run.log'), 'utf8')).toMatch(/KILLED_BY=signal SIGTERM, cause unknown\nEXIT=143\n$/)
  })
  it('reports timeout for owner decision without killing live work', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '1']); expect(res.status).toBe(0)
    const pidFile = join(f.dir, 'opencode.pid'); waitForFile(pidFile)
    const status = currentStateFile(f.dir)
    const until = Date.now() + 3000
    while (Date.now() < until && !readFileSync(status, 'utf8').includes('decision-needed')) spawnSync('sleep', ['0.05'])
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({ state: 'decision-needed', defaultDecision: 'extend' })
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0)).not.toThrow()
    expect(existsSync(join(f.dir, '.lane', 'run.log')) ? readFileSync(join(f.dir, '.lane', 'run.log'), 'utf8') : '').not.toMatch(/EXIT=/)
    const worker = Number(/pid=(\d+)/.exec(res.stdout)?.[1])
    process.kill(worker, 'SIGTERM')
    const cleanupUntil = Date.now() + 4000
    while (Date.now() < cleanupUntil) { try { process.kill(worker, 0); spawnSync('sleep', ['0.05']) } catch { break } }
  })
  it('refuses a second live lane with a remedy that waits for an actionable decision point', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const first = run(f, ['--timeout', '60']); expect(first.status).toBe(0)
    const status = currentStateFile(f.dir); waitForFile(join(f.dir, 'opencode.pid'))
    waitForContent(status, /"state": "running"/)
    const second = run(f, ['--timeout', '60'])
    expect(second.status).toBe(1)
    expect(second.stderr).toContain(`wait until the lane reaches decision-needed, then abandon with node '${CONTROL}' --dir '${f.dir}' --decision abandon`)
    const state = JSON.parse(readFileSync(status, 'utf8'))
    killIdentity({ pid: state.workerPid, argv: state.workerArgv }, 'SIGTERM')
  })
  it('serializes simultaneous launch guards before either worker can replace the pointer', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    f.env.SLOW_PREFLIGHT_AT_COUNT = '2'
    const argv = [LAUNCHER, '--dir', f.dir, '--model', 'openai/gpt-5.6-luna', '--brief', join(f.dir, 'brief.md'), '--allow-no-git', '--timeout', '60']
    const first = spawnChild(process.execPath, argv, { env: f.env })
    const second = spawnChild(process.execPath, argv, { env: f.env })
    const collect = (child: ChildProcess) => new Promise<{ code: number | null, stderr: string }>((resolve) => { let stderr = ''; child.stderr?.on('data', (data) => { stderr += data }); child.on('close', (code) => resolve({ code, stderr })) })
    return Promise.all([collect(first), collect(second)]).then((results) => {
      expect(results.map(({ code }) => code).sort()).toEqual([0, 1])
      expect(results.find(({ code }) => code === 1)?.stderr).toContain('another lane launch is in progress')
      expect(results.find(({ code }) => code === 1)?.stderr).not.toContain('--decision abandon')
      const state = JSON.parse(readFileSync(currentStateFile(f.dir), 'utf8'))
      killIdentity({ pid: state.workerPid, argv: state.workerArgv, startTime: state.workerStartTime }, 'SIGTERM')
    })
  })
  it('never recovers an old launch lock while its recorded owner is still alive', async () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    f.env.SLOW_PREFLIGHT_AT_COUNT = '1'
    const argv = [LAUNCHER, '--dir', f.dir, '--model', 'openai/gpt-5.6-luna', '--brief', join(f.dir, 'brief.md'), '--allow-no-git', '--timeout', '60']
    const first = spawnChild(process.execPath, argv, { env: f.env })
    const lock = join(f.dir, '.lane', 'supervision', 'launch.lock')
    waitForFile(join(lock, 'owner.json'))
    const old = new Date(Date.now() - 121_000)
    utimesSync(lock, old, old)
    const second = spawnSync(process.execPath, argv, { encoding: 'utf8', env: f.env })
    await new Promise<void>((resolve) => first.on('close', () => resolve()))
    try {
      expect(second.status).toBe(1)
      expect(second.stderr).toContain('another lane launch is in progress')
    } finally {
      for (const name of readdirSync(join(f.dir, '.lane', 'supervision')).filter((item) => /^\d+-\d+\.json$/.test(item))) {
        const state = JSON.parse(readFileSync(join(f.dir, '.lane', 'supervision', name), 'utf8'))
        const identity = inspectProcess(state.workerPid)
        if (sameIdentity({ pid: state.workerPid, argv: state.workerArgv, startTime: state.workerStartTime }, identity)) process.kill(state.workerPid, 'SIGTERM')
      }
    }
  }, 15_000)
  it('does not release a launch lock after its owner record has been replaced', async () => {
    const f = fixture('sleep 0.2')
    f.env.SLOW_PREFLIGHT_AT_COUNT = '1'
    const first = spawnChild(process.execPath, [LAUNCHER, '--dir', f.dir, '--model', 'openai/gpt-5.6-luna', '--brief', join(f.dir, 'brief.md'), '--allow-no-git'], { env: f.env })
    const ownerFile = join(f.dir, '.lane', 'supervision', 'launch.lock', 'owner.json')
    waitForFile(ownerFile)
    writeFileSync(ownerFile, JSON.stringify({ runId: 'foreign', pid: process.pid, argv: process.argv, startTime: inspectProcess(process.pid)?.startTime ?? null }))
    await new Promise<void>((resolve) => first.on('close', () => resolve()))
    expect(existsSync(ownerFile)).toBe(true)
    const state = JSON.parse(readFileSync(currentStateFile(f.dir), 'utf8'))
    killIdentity({ pid: state.workerPid, argv: state.workerArgv, startTime: state.workerStartTime }, 'SIGTERM')
  }, 15_000)
  it('removes only its own placeholder when another run wins the current pointer', () => {
    const f = fixture('true')
    const paths = supervisionPaths(f.dir, '10-1')
    mkdirSync(paths.dir, { recursive: true })
    writeFileSync(paths.record, '{}')
    const claimed = claimCurrentSupervision(paths, '10-1', {
      writePointer: (file: string, value: unknown) => {
        writeJsonAtomic(file, value)
        writeJsonAtomic(file, { version: 1, runId: '20-2' })
      },
    })
    expect(claimed).toBe(false)
    expect(existsSync(paths.record)).toBe(false)
    expect(JSON.parse(readFileSync(paths.pointer, 'utf8'))).toMatchObject({ runId: '20-2' })
  })
  it('uses an explicitly approximate spawn clock, never the unrelated performance time origin, for Windows fallback identity', () => {
    const source = readFileSync(LAUNCHER, 'utf8')
    expect(source).not.toContain('performance.timeOrigin')
    expect(source).toContain('startTime: spawnedAt, startTimeApproximate: true')
  })
  it('captures the provider identity when a Darwin process becomes readable on the third call', () => {
    let calls = 0
    const expected = { pid: 42, argv: ['/usr/local/bin/node lane.mjs'], startTime: 123, groupId: 42, cwd: '/lane' }
    const result = inspectStartedProcess(() => {
      calls += 1
      return calls < 3 ? null : expected
    }, 42, { platform: 'darwin', timeoutMs: DARWIN_PROVIDER_MISS_TTL_MS * 3 + PROCESS_CAPTURE_SCHEDULING_MARGIN_MS })
    expect(calls).toBeGreaterThanOrEqual(3)
    expect(result).toEqual({ identity: expected, unavailable: null })
  })
  it('waits through a transient Darwin shell transcript before capturing the stable command', () => {
    const start = 'Wed Sep 16 12:34:56 2026'
    const commands = ['(bash)', '(bash)', '/usr/local/bin/node lane.mjs --worker']
    const execFile = ((program: string) => {
      if (program === 'ps') return { status: 0, stdout: `  42 ${start}   42 S ${commands.shift() ?? '/usr/local/bin/node lane.mjs --worker'}\n` }
      return { status: 0, stdout: 'p42\nfcwd\nn/private/var/folders/lane\n' }
    }) as typeof spawnSync
    const inspect = (pid: number, options: { platform: NodeJS.Platform }) => inspectProcess(pid, { ...options, spawnSync: execFile })

    const first = inspect(42, { platform: 'darwin' })
    expect(first?.argv).toEqual(['(bash)'])
    // Each transcript transition now costs one 100 ms table TTL on darwin; the bound is about the
    // sequence, not about 250 ms (run 23: 250 ms was marginal on the macOS runner).
    expect(inspectStartedProcess(inspect, 42, { platform: 'darwin', timeoutMs: 2_000 }).identity?.argv)
      .toEqual(['/usr/local/bin/node lane.mjs --worker'])
  })
  it('captures Darwin cwd once when lsof takes two seconds', () => {
    let lsofCalls = 0
    const execFile = ((program: string) => {
      if (program === 'lsof') {
        lsofCalls += 1
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 2_000)
        return { status: 0, stdout: 'p42\nfcwd\nn/private/var/folders/lane\n' }
      }
      return { status: 0, stdout: '  42 Wed Sep 16 12:34:56 2026   42 S /usr/local/bin/node lane.mjs --worker\n' }
    }) as typeof spawnSync
    const inspect = (pid: number, options: { platform: NodeJS.Platform, captureCwd?: boolean }) => inspectProcess(pid, { ...options, spawnSync: execFile })
    const started = Date.now()

    expect(inspectStartedProcess(inspect, 42, { platform: 'darwin', timeoutMs: 5_000 }).identity?.cwd).toBe('/private/var/folders/lane')
    expect(Date.now() - started).toBeLessThan(3_000)
    expect(lsofCalls).toBe(1)
  }, 3_500)
  it('records a source-specific unavailable state instead of a synthetic identity', () => {
    expect(inspectStartedProcess(() => null, 42, { platform: 'darwin', timeoutMs: PROCESS_CAPTURE_RETRY_MS * 2 })).toEqual({ identity: null, unavailable: 'unavailable (ps)' })
    expect(classifyLane({ runId: '42-1', state: 'running', workerPid: 42, workerArgv: null, workerStartTime: null, workerIdentity: 'unavailable (ps)', childPid: null, childArgv: null }, { platform: 'darwin' }))
      .toMatchObject({ status: 'unknown', reason: 'worker identity unavailable (ps)' })
  })
  it('recovers and journals a stale launch lock whose recorded owner is gone', () => {
    const f = fixture('sleep 0.2')
    const lock = join(f.dir, '.lane', 'supervision', 'launch.lock')
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ pid: 999999, argv: ['node', 'gone'], startTime: 1, createdAt: new Date().toISOString() }))
    const result = run(f)
    expect(result.status, result.stderr).toBe(0)
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    expect(readFileSync(journal, 'utf8')).toContain('"event":"launch-lock-recovered"')
  })
  it('recovers a launch-lock recovery marker whose recorded owner is gone', () => {
    const f = fixture('sleep 0.2')
    const supervision = join(f.dir, '.lane', 'supervision')
    const lock = join(supervision, 'launch.lock')
    const recovery = join(supervision, 'launch.lock.recovery')
    const deadOwner = { version: 1, runId: '999999-1', pid: 999999, argv: ['node', 'gone'], startTime: 1, createdAt: new Date().toISOString() }
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner.json'), JSON.stringify(deadOwner))
    mkdirSync(recovery)
    writeFileSync(join(recovery, 'owner.json'), JSON.stringify(deadOwner))
    const result = run(f)
    expect(result.status, result.stderr).toBe(0)
    expect(existsSync(recovery)).toBe(false)
  })
  it('respects a launch-lock recovery marker whose recorded owner is alive', () => {
    const f = fixture('sleep 0.2')
    const supervision = join(f.dir, '.lane', 'supervision')
    const lock = join(supervision, 'launch.lock')
    const recovery = join(supervision, 'launch.lock.recovery')
    const deadOwner = { version: 1, runId: '999999-1', pid: 999999, argv: ['node', 'gone'], startTime: 1, createdAt: new Date().toISOString() }
    const identity = inspectProcess(process.pid)
    expect(identity).not.toBeNull()
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner.json'), JSON.stringify(deadOwner))
    mkdirSync(recovery)
    writeFileSync(join(recovery, 'owner.json'), JSON.stringify({ version: 1, runId: `${process.pid}-1`, pid: process.pid, argv: identity!.argv, startTime: identity!.startTime, createdAt: new Date().toISOString() }))
    const old = new Date(Date.now() - 121_000)
    utimesSync(recovery, old, old)
    const result = run(f)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain(recovery)
    expect(result.stderr).toContain('owner process is still running')
    expect(existsSync(recovery)).toBe(true)
  })
  it('recovers a launch lock when its live pid has a different start time', () => {
    const f = fixture('sleep 0.2')
    const lock = join(f.dir, '.lane', 'supervision', 'launch.lock')
    const identity = inspectProcess(process.pid)
    expect(identity).not.toBeNull()
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ version: 1, runId: `${process.pid}-1`, pid: process.pid, argv: identity!.argv, startTime: identity!.startTime + 1, createdAt: new Date().toISOString() }))
    const result = run(f)
    expect(result.status, result.stderr).toBe(0)
  })
  it('falls through an EPERM signal probe to the owner start-time identity test', () => {
    const f = fixture('sleep 0.2')
    const lock = join(f.dir, '.lane', 'supervision', 'launch.lock')
    const preload = join(f.root, 'eperm.cjs')
    const identity = inspectProcess(process.pid)
    expect(identity).not.toBeNull()
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ version: 1, runId: `${process.pid}-1`, pid: process.pid, argv: identity!.argv, startTime: identity!.startTime + 1, createdAt: new Date().toISOString() }))
    writeFileSync(preload, "const originalKill = process.kill; process.kill = function (pid, signal) { if (pid === Number(process.env.EPERM_PID) && signal === 0) throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); return originalKill.call(process, pid, signal) }\n")
    const result = spawnSync(process.execPath, [LAUNCHER, '--dir', f.dir, '--model', 'openai/gpt-5.6-luna', '--brief', join(f.dir, 'brief.md'), '--allow-no-git'], { encoding: 'utf8', env: { ...f.env, NODE_OPTIONS: `--require=${preload}`, EPERM_PID: String(process.pid) } })
    expect(result.status, result.stderr).toBe(0)
  })
  it('age-bounds an EPERM owner when its start-time identity is still undecidable', () => {
    const f = fixture('sleep 0.2')
    const lock = join(f.dir, '.lane', 'supervision', 'launch.lock')
    const preload = join(f.root, 'eperm-unknown.cjs')
    mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'owner.json'), JSON.stringify({ version: 1, runId: `${process.pid}-1`, pid: process.pid, argv: process.argv, startTime: null, createdAt: new Date().toISOString() }))
    const old = new Date(Date.now() - 121_000)
    utimesSync(lock, old, old)
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'darwin' }); const originalKill = process.kill; process.kill = function (pid, signal) { if (pid === Number(process.env.EPERM_PID) && signal === 0) throw Object.assign(new Error('not permitted'), { code: 'EPERM' }); return originalKill.call(process, pid, signal) }\n")
    const result = spawnSync(process.execPath, [LAUNCHER, '--dir', f.dir, '--model', 'openai/gpt-5.6-luna', '--brief', join(f.dir, 'brief.md'), '--allow-no-git'], { encoding: 'utf8', env: { ...f.env, NODE_OPTIONS: `--require=${preload}`, EPERM_PID: String(process.pid) } })
    expect(result.status, result.stderr).toBe(0)
  })
  it('launches a second lane on Darwin after provider evidence reports the first gone', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const first = run(f, ['--timeout', '60']); expect(first.status).toBe(0)
    const status = currentStateFile(f.dir); waitForFile(join(f.dir, 'opencode.pid'))
    waitForContent(status, /"state": "running"/)
    const state = JSON.parse(readFileSync(status, 'utf8'))
    const worker = { pid: state.workerPid, argv: state.workerArgv, startTime: state.workerStartTime }
    killIdentity(worker, 'SIGTERM'); waitForIdentityExit(worker)
    const preload = join(f.root, 'darwin.cjs')
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'darwin' })\n")
    const second = spawnSync(process.execPath, [LAUNCHER, '--dir', f.dir, '--model', 'openai/gpt-5.6-luna', '--brief', join(f.dir, 'brief.md'), '--allow-no-git'], { encoding: 'utf8', env: { ...f.env, NODE_OPTIONS: `--require=${preload}` } })
    expect(second.status, second.stderr).toBe(0)
    const secondState = JSON.parse(readFileSync(currentStateFile(f.dir), 'utf8'))
    killIdentity(inspectProcess(secondState.workerPid), 'SIGTERM')
  })
  it('supersedes and journals an unknown record only after its recorded hard bound', () => {
    const f = fixture('sleep 0.2')
    const dir = join(f.dir, '.lane', 'supervision'); mkdirSync(dir)
    const stale = { runId: '2-1', state: 'running', workerPid: 2, childPid: 3, worktree: f.dir, timeoutAt: new Date(Date.now() - 10_000).toISOString(), timeoutSeconds: 1, decisionGraceSeconds: 1, maxExtensions: 0, extensionCount: 0, decisionTransitionBoundMs: 0 }
    writeFileSync(join(dir, '2-1.json'), JSON.stringify(stale)); writeFileSync(join(dir, 'current.json'), JSON.stringify({ runId: stale.runId }))
    const result = run(f)
    expect(result.status, result.stderr).toBe(0)
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    expect(readFileSync(journal, 'utf8')).toContain('"event":"superseded"')
  })
  it('refuses an unreadable current pointer as unknown', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    const dir = join(f.dir, '.lane', 'supervision'); mkdirSync(dir)
    writeFileSync(join(dir, 'current.json'), '{')
    const result = run(f)
    expect(result.status).toBe(1)
    expect(result.stderr).toContain('current lane supervision is unreadable')
    expect(result.stderr).toContain('remove')
    expect(result.stderr).not.toContain('--decision abandon')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it('keeps one immutable supervision record per run behind an atomic current pointer', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '1']); expect(res.status).toBe(0)
    waitForFile(join(f.dir, '.lane', 'supervision', 'current.json'))
    const pointer = JSON.parse(readFileSync(join(f.dir, '.lane', 'supervision', 'current.json'), 'utf8'))
    const recordFile = join(f.dir, '.lane', 'supervision', `${pointer.runId}.json`)
    waitForContent(recordFile, /decision-needed/)
    expect(JSON.parse(readFileSync(recordFile, 'utf8'))).toMatchObject({ runId: pointer.runId, state: 'decision-needed' })
    expect(readdirSync(join(f.dir, '.lane', 'supervision')).filter((name) => /^\d+-\d+\.json$/.test(name))).toContain(`${pointer.runId}.json`)
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGTERM')
  })
  it('records the stated extend default when the decision grace expires and still keeps work alive', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '1', '--decision-grace', '0']); expect(res.status).toBe(0)
    const pidFile = join(f.dir, 'opencode.pid'); waitForFile(pidFile)
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    waitForContent(journal, /"source":"grace-default"/)
    expect(readFileSync(journal, 'utf8')).toContain('"decision":"extend"')
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0)).not.toThrow()
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGTERM')
  })
  it('re-arms grace defaults and abandons at the configured extension ceiling', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '0.2', '--decision-grace', '0', '--max-extensions', '1']); expect(res.status).toBe(0)
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    waitForContent(journal, /"decision":"abandon"/, 4000)
    const text = readFileSync(journal, 'utf8')
    expect((text.match(/"source":"grace-default"/g) ?? [])).toHaveLength(2)
    expect(text).toContain('"decision":"extend"')
    expect(text).toContain('"decision":"abandon"')
  })
  it('ends the child at its extension ceiling even when Linux process inspection is unavailable', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const preload = join(f.root, 'darwin.cjs')
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'darwin' })\n")
    const result = spawnSync(process.execPath, [LAUNCHER, '--dir', f.dir, '--model', 'openai/gpt-5.6-luna', '--brief', join(f.dir, 'brief.md'), '--allow-no-git', '--timeout', '0.2', '--decision-grace', '0', '--max-extensions', '0'], { encoding: 'utf8', env: { ...f.env, NODE_OPTIONS: `--require=${preload}` } })
    expect(result.status, result.stderr).toBe(0)
    const pidFile = join(f.dir, 'opencode.pid'); waitForFile(pidFile)
    waitFor(join(f.dir, '.lane', 'run.log'), 4000)
    const pid = Number(readFileSync(pidFile, 'utf8').trim()); const until = Date.now() + 4000; let alive = true
    while (Date.now() < until) { try { process.kill(pid, 0); spawnSync('sleep', ['0.05']) } catch { alive = false; break } }
    expect(alive).toBe(false)
  })
  it('records launch-failed when the real worker fails its own preflight', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    const countFile = join(f.dir, '.lane', 'preflight-count')
    f.env.FAIL_PREFLIGHT_AT_COUNT = '2'
    const result = run(f)
    expect(result.status, result.stderr).toBe(0)
    const stateFile = currentStateFile(f.dir, 4000)
    waitForContent(stateFile, /launch-failed/, 4000)
    expect(readFileSync(countFile, 'utf8')).toBe('2')
    expect(JSON.parse(readFileSync(stateFile, 'utf8'))).toMatchObject({ state: 'launch-failed' })
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
    expect(run(f).status).toBe(0)
  })
  it('keeps worktree files when the owner abandons and starts a fresh lane with the normal launcher', () => {
    const f = fixture('if [ ! -f "$PWD/progress" ]; then printf kept > "$PWD/progress"; echo $$ > "$PWD/first.pid"; sleep 30; else sleep 0.5; printf resumed > "$PWD/resumed"; fi')
    f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const res = run(f, ['--timeout', '1', '--decision-grace', '10']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir)
    waitForContent(status, /decision-needed/)
    waitForVerdict(status, 'decision-needed')
    writeFileSync(currentDecisionFile(f.dir), JSON.stringify({ runId: 'stale', timeoutAt: 'stale', decision: 'abandon' }))
    const control = spawnSync(process.execPath, [CONTROL, '--dir', f.dir, '--decision', 'abandon', '--reason', 'e2e stalled fixture'], { encoding: 'utf8', env: f.env })
    expect(control.status, control.stderr).toBe(0)
    waitForContent(status, /abandoned/)
    const fresh = run(f, ['--timeout', '10'])
    expect(fresh.status, fresh.stderr).toBe(0)
    waitForFile(join(f.dir, 'resumed'), 5000)
    expect(readFileSync(join(f.dir, 'progress'), 'utf8')).toBe('kept')
    expect(readFileSync(join(f.dir, 'resumed'), 'utf8')).toBe('resumed')
    waitForContent(join(f.dir, '.lane', 'run.log'), /EXIT=0/)
    expect(readFileSync(join(f.dir, '.lane', 'run.log'), 'utf8')).toMatch(/EXIT=0\n$/)
    expect((readFileSync(join(f.dir, '.lane', 'run.log'), 'utf8').match(/^EXIT=/gm) ?? [])).toHaveLength(1)
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    waitForContent(journal, /"decision":"abandon"/)
    expect(readFileSync(journal, 'utf8')).toContain('"decision":"abandon"')
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({ state: 'abandoned', decision: 'abandon', decisionSource: 'owner', timeoutAt: expect.any(String) })
  })
  it('abandons a lane launched through a symlinked worktree path', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const target = f.dir
    const linked = join(f.root, 'linked-worktree')
    symlinkSync(target, linked, 'dir')
    f.dir = linked
    const result = run(f, ['--timeout', '0.2', '--decision-grace', '10'])
    expect(result.status, result.stderr).toBe(0)
    const status = currentStateFile(f.dir)
    waitForContent(status, /decision-needed/)
    const control = spawnSync(process.execPath, [CONTROL, '--dir', f.dir, '--decision', 'abandon'], { encoding: 'utf8', env: f.env })
    expect(control.status, control.stderr).toBe(0)
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({ state: 'abandoned' })
  })
  it('does not treat an old EXIT marker as an orphan while the current launcher is alive', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    writeFileSync(join(f.dir, '.lane', 'run.log'), 'old run\nEXIT=0\n')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const pidFile = join(f.dir, 'opencode.pid'); waitForFile(pidFile)
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
    expect(watcher.status, watcher.stderr).toBe(0)
    expect(watcher.stdout).not.toContain('would-clean')
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    const pid = Number(readFileSync(pidFile, 'utf8').trim())
    expect(() => process.kill(pid, 0)).not.toThrow()
    expect(readFileSync(join(f.dir, '.lane', 'run.log'), 'utf8')).toMatch(/^LANE_RUN_ID=/)
    expect(readFileSync(join(f.dir, '.lane', 'run.log'), 'utf8')).not.toContain('old run')
    expect(readFileSync(journal, 'utf8')).not.toContain('"event":"would-clean"')
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGTERM')
  }, 60_000)
  it('observe mode journals would-clean but kills nothing', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    isolateWatcherHostCensus(f)
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); const pidFile = join(f.dir, 'opencode.pid')
    waitForContent(status, /"state": "running"/); waitForFile(pidFile)
    const orphan = installDeterministicOrphan(status, f.dir)
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
    expect(watcher.status, watcher.stderr).toBe(0)
    expect(() => process.kill(orphan.pid, 0)).not.toThrow()
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    expect(readFileSync(journal, 'utf8')).toContain('"event":"would-clean"')
    killIdentity(orphan, 'SIGKILL')
  })
  it('abandons a live orphan when its worker is gone', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const res = run(f, ['--timeout', '1', '--decision-grace', '30']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); const pidFile = join(f.dir, 'opencode.pid')
    waitForContent(status, /decision-needed/); waitForFile(pidFile)
    const state = JSON.parse(readFileSync(status, 'utf8'))
    const worker = { pid: state.workerPid, argv: state.workerArgv, startTime: state.workerStartTime }
    killIdentity(worker, 'SIGKILL'); waitForIdentityExit(worker)
    waitForVerdict(status, 'worker-gone-child-alive')
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
    expect(watcher.stdout).toContain('worker-gone-child-alive')
    const control = spawnSync(process.execPath, [CONTROL, '--dir', f.dir, '--decision', 'abandon'], { encoding: 'utf8', env: f.env })
    expect(control.status, control.stderr).toBe(0)
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({ state: 'abandoned' })
    expect(() => process.kill(Number(readFileSync(pidFile, 'utf8')), 0)).toThrow()
  })
  it.each([
    ['pilot', 'stalled'],
    ['pilot', 'would-clean'],
    ['foreign session', 'stalled'],
    ['foreign session', 'would-clean'],
  ])('journals one %s-owned %s episode across repeated sweeps', (ownerKind, event) => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const ownerArgs = ownerKind === 'pilot' ? ['--owner', 'pilot', '--owner-token', 'pilot-token'] : []
    const res = run(f, ['--timeout', '60', ...ownerArgs]); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); const pidFile = join(f.dir, 'opencode.pid')
    waitForContent(status, /"state": "running"/); waitForFile(pidFile); waitForVerdict(status, 'running')
    const state = JSON.parse(readFileSync(status, 'utf8'))
    const workerIdentity = inspectProcess(state.workerPid)
    if (!workerIdentity) throw new Error('worker identity disappeared before the watcher fixture was ready')
    let watchedChildIdentity = { pid: state.childPid, argv: state.childArgv, startTime: state.childStartTime, cwd: state.worktree }
    if (event === 'would-clean') {
      // This test is about watcher episode deduplication, not launcher signal propagation.
      // Give it a deterministically gone worker and a fresh child whose full identity we own.
      killIdentity(workerIdentity, 'SIGKILL')
      waitForIdentityExit(workerIdentity)
      const replacement = spawnChild(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { cwd: f.dir, stdio: 'ignore' })
      const replacementDeadline = Date.now() + 5_000
      let replacementIdentity = inspectProcess(replacement.pid!)
      while (!replacementIdentity && Date.now() < replacementDeadline) {
        spawnSync('sleep', ['0.05'])
        replacementIdentity = inspectProcess(replacement.pid!)
      }
      if (!replacementIdentity) throw new Error('replacement child identity did not become visible')
      watchedChildIdentity = replacementIdentity
      writeFileSync(status, JSON.stringify({
        ...state,
        state: 'abandoned',
        workerPid: 2_147_483_647,
        workerArgv: ['gone-test-worker'],
        workerStartTime: 0,
        childPid: replacementIdentity.pid,
        childArgv: replacementIdentity.argv,
        childStartTime: replacementIdentity.startTime,
      }))
    } else {
      const old = new Date(Date.now() - 120_000)
      const ageTree = (dir: string) => {
        for (const name of readdirSync(dir)) {
          const file = join(dir, name)
          if (file === join(f.dir, '.lane', 'supervision')) continue
          if (statSync(file).isDirectory()) ageTree(file)
          utimesSync(file, old, old)
        }
      }
      ageTree(f.dir); utimesSync(f.dir, old, old)
    }
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    const sweepLog = join(f.root, 'sweeps.log')
    const watcher = spawnWatcher(['--project', f.dir, '--poll', '0.05'], {
      stdio: 'ignore',
      env: { ...f.env, CLAUDE_CODE_SESSION_ID: 'watching-session', WT_LANE_STALL_MINUTES: '1', WT_LANE_WATCH_TEST_SWEEP_LOG: sweepLog },
    })
    const watcherIdentity = inspectProcess(watcher.pid!)
    waitForContent(journal, new RegExp(`"event":"${event}"`))
    waitForLines(sweepLog, 2)
    killIdentity(watcherIdentity, 'SIGTERM')
    expect(existsSync(journal)).toBe(true)
    expect(journalEvents(journal, event)).toHaveLength(1)
    expect(journalEvents(journal, event)[0]).toMatchObject({ runId: state.runId })
    if (event === 'would-clean') {
      killIdentity(watchedChildIdentity, 'SIGKILL')
      const originalChild = inspectProcess(state.childPid)
      if (sameIdentity({ pid: state.childPid, argv: state.childArgv, startTime: state.childStartTime }, originalChild)) {
        killIdentity({ pid: state.childPid, argv: state.childArgv, startTime: state.childStartTime, cwd: state.worktree }, 'SIGKILL')
      }
    } else {
      const actualWorker = inspectProcess(workerIdentity.pid)
      if (sameIdentity(workerIdentity, actualWorker)) killIdentity(workerIdentity, 'SIGTERM')
    }
  }, 60_000)
  it('journals a stalled episode again after it clears and recurs for the same runId', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 120')
    isolateWatcherHostCensus(f)
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); waitForFile(join(f.dir, 'opencode.pid'))
    const state = JSON.parse(readFileSync(status, 'utf8'))
    const marker = join(f.dir, 'activity')
    const old = new Date(Date.now() - 120_000)
    const ageTree = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name)
        if (file === join(f.dir, '.lane', 'supervision')) continue
        if (statSync(file).isDirectory()) ageTree(file)
        utimesSync(file, old, old)
      }
    }
    writeFileSync(marker, 'old'); ageTree(f.dir); utimesSync(f.dir, old, old)
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    const sweepLog = join(f.root, 'sweeps.log')
    const watcher = spawnWatcher(['--project', f.dir, '--poll', '0.1'], { stdio: 'ignore', env: { ...f.env, WT_LANE_STALL_MINUTES: '1', WT_LANE_WATCH_TEST_SWEEP_LOG: sweepLog } })
    waitForContent(journal, /"event":"stalled"/)
    writeFileSync(marker, 'fresh')
    waitForContent(sweepLog, new RegExp(`${state.runId}:stalled:cleared`))
    ageTree(f.dir); utimesSync(f.dir, old, old)
    waitForContent(journal, /"event":"stalled".*\n.*"event":"stalled"/s)
    killIdentity(inspectProcess(watcher.pid!), 'SIGTERM')
    expect(journalEvents(journal, 'stalled')).toHaveLength(2)
    expect(new Set(journalEvents(journal, 'stalled').map((item) => item.runId))).toEqual(new Set([state.runId]))
    expect(new Set(journalEvents(journal, 'stalled').map((item) => item.episodeStartedAt)).size).toBe(2)
    killIdentity({ pid: state.workerPid, argv: state.workerArgv }, 'SIGTERM')
  }, 60_000)
  it('enforce mode escalates and journals cleaned only after the orphan is gone', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); const pidFile = join(f.dir, 'opencode.pid')
    waitForContent(status, /"state": "running"/); waitForFile(pidFile)
    const orphan = installDeterministicGroupedOrphan(status, f.dir)
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: { ...f.env, WT_LANE_ORPHAN_CLEANUP: 'enforce' }, timeout: 30_000 })
    expect(watcher.status, `${watcher.error ?? ''}\n${watcher.stderr}`).toBe(0)
    const journal = join(f.root, 'state', 'workflow-toolbox', 'lane-supervisor', 'lane-supervisor.jsonl')
    expect(readFileSync(journal, 'utf8')).toContain('"event":"cleaned"')
    expect(() => process.kill(orphan.pid, 0)).toThrow()
  }, 60_000)
  it('keeps polling after a journal write failure', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); const pidFile = join(f.dir, 'opencode.pid')
    waitForContent(status, /"state": "running"/); waitForFile(pidFile)
    const orphan = installDeterministicOrphan(status, f.dir)
    const blocked = join(f.root, 'blocked-state'); writeFileSync(blocked, 'not a directory')
    const sweepLog = join(f.root, 'sweeps.log')
    const watcher = spawnWatcher(['--project', f.dir, '--poll', '0.05'], { stdio: 'ignore', env: { ...f.env, XDG_STATE_HOME: blocked, WT_LANE_WATCH_TEST_SWEEP_LOG: sweepLog } })
    waitForLines(sweepLog, 2, 50_000)
    expect(() => process.kill(watcher.pid!, 0)).not.toThrow()
    process.kill(watcher.pid!, 'SIGTERM')
    killIdentity(orphan, 'SIGKILL')
  }, 90_000)
  it('a test sweep receipt failure is reported but cannot fail the sweep', () => {
    const f = fixture('sleep 1')
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], {
      encoding: 'utf8',
      env: { ...f.env, WT_LANE_WATCH_TEST_SWEEP_LOG: f.root },
    })
    expect(watcher.status, watcher.stderr).toBe(0)
    expect(watcher.stderr).toContain('LANE ORPHAN WATCH TEST MODE')
    expect(watcher.stderr).toContain('WT_LANE_WATCH_TEST_SWEEP_LOG')
    expect(watcher.stderr).toContain('test sweep log write failed; watcher behavior unchanged')
  })
  it('reports a failed enforce kill journal on stdout', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); const pidFile = join(f.dir, 'opencode.pid')
    waitForContent(status, /"state": "running"/); waitForFile(pidFile)
    installDeterministicGroupedOrphan(status, f.dir)
    const blocked = join(f.root, 'blocked-state'); writeFileSync(blocked, 'not a directory')
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: { ...f.env, XDG_STATE_HOME: blocked, WT_LANE_ORPHAN_CLEANUP: 'enforce' }, timeout: 30_000 })
    expect(watcher.status, `${watcher.error ?? ''}\n${watcher.stderr}`).toBe(0)
    expect(watcher.stdout).toContain('kill journal failed')
  }, 60_000)
  it('on Darwin, says once that watcher-orphan detection is unavailable and still completes the sweep', () => {
    const f = fixture('sleep 0.2')
    const preload = join(f.root, 'darwin.cjs')
    writeFileSync(preload, "Object.defineProperty(process, 'platform', { value: 'darwin' })\n")
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], {
      encoding: 'utf8',
      env: { ...f.env, NODE_OPTIONS: `--require=${preload}` },
    })
    expect(watcher.status, watcher.stderr).toBe(0)
    expect(watcher.stdout.split('\n').filter((line) => line.includes('/proc required'))).toHaveLength(1)
  })
  it('prints owner notices even when the journal is unavailable and reports that failure once', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); const pidFile = join(f.dir, 'opencode.pid')
    waitForContent(status, /"state": "running"/); waitForFile(pidFile)
    const orphan = installDeterministicOrphan(status, f.dir)
    const blocked = join(f.root, 'blocked-state'); writeFileSync(blocked, 'not a directory')
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: { ...f.env, XDG_STATE_HOME: blocked } })
    expect(watcher.stdout).toContain('LANE would-clean:')
    expect((watcher.stderr.match(/journal write failed/g) ?? [])).toHaveLength(1)
    killIdentity(orphan, 'SIGKILL')
  })
  it('prints a stalled owner notice even when the journal is unavailable', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); waitForContent(status, /"state": "running"/); waitForFile(join(f.dir, 'opencode.pid')); waitForVerdict(status, 'running')
    const old = new Date(Date.now() - 120_000)
    const ageTree = (dir: string) => {
      for (const name of readdirSync(dir)) {
        const file = join(dir, name)
        if (file === join(f.dir, '.lane', 'supervision')) continue
        if (statSync(file).isDirectory()) ageTree(file)
        utimesSync(file, old, old)
      }
    }
    ageTree(f.dir); utimesSync(f.dir, old, old)
    const blocked = join(f.root, 'blocked-state'); writeFileSync(blocked, 'not a directory')
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: { ...f.env, XDG_STATE_HOME: blocked, WT_LANE_STALL_MINUTES: '1' } })
    expect(watcher.stdout).toContain('LANE stalled:')
    expect((watcher.stderr.match(/journal write failed/g) ?? [])).toHaveLength(1)
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGTERM')
  })
  it.skipIf(process.platform !== 'linux')('prints an unattributed warning even when the journal is unavailable [requires Linux /proc orphan enumeration]', async () => {
    const f = fixture('true')
    const child = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'opencode', 'run'], { cwd: f.dir, stdio: 'ignore' })
    try {
      spawnSync('sleep', ['0.1'])
      const blocked = join(f.root, 'blocked-state'); writeFileSync(blocked, 'not a directory')
      const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: { ...f.env, XDG_STATE_HOME: blocked } })
      expect(watcher.stdout).toContain(`WARNING: unattributed opencode pid=${child.pid}`)
      expect((watcher.stderr.match(/journal write failed/g) ?? [])).toHaveLength(1)
    } finally {
      try { process.kill(child.pid!, 'SIGKILL') } catch {}
    }
  })
  it.skipIf(process.platform !== 'linux')('attributes an allow-no-git lane from its plain-directory owner record [requires Linux /proc orphan enumeration]', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const runtime = join(f.root, 'fake-opencode-runtime.mjs'); copyFileSync(FAKE_OPENCODE, runtime)
    writeFileSync(join(f.root, 'bin', 'opencode'), `#!/bin/sh\nexec ${JSON.stringify(process.execPath)} ${JSON.stringify(runtime)} opencode "$@"\n`)
    const launch = run(f, ['--timeout', '60']); expect(launch.status, launch.stderr).toBe(0)
    const workerPid = Number(/^pid=(\d+)$/m.exec(launch.stdout)?.[1])
    const stateFile = currentStateFile(f.dir)
    waitForContent(stateFile, /"state": "running"/); waitForFile(join(f.dir, 'opencode.pid'))
    const childPid = JSON.parse(readFileSync(stateFile, 'utf8')).childPid
    try {
      const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.root, '--once'], { encoding: 'utf8', env: f.env })
      expect(watcher.status, watcher.stderr).toBe(0)
      expect(watcher.stdout).not.toContain(`WARNING: unattributed opencode pid=${childPid}`)
    } finally {
      try { process.kill(workerPid, 'SIGTERM') } catch {}
    }
  })
  it.skipIf(process.platform !== 'linux')('still warns for a plain-directory opencode process with no owner record [requires Linux /proc orphan enumeration]', () => {
    const f = fixture('true')
    const plain = join(f.root, 'plain'); mkdirSync(plain)
    const child = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'opencode', 'run', '--dir', plain], { cwd: plain, stdio: 'ignore' })
    spawnSync('sleep', ['0.1'])
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.root, '--once'], { encoding: 'utf8', env: f.env })
    expect(watcher.status, watcher.stderr).toBe(0)
    expect(watcher.stdout).toContain(`WARNING: unattributed opencode pid=${child.pid}`)
  })
  it.skipIf(process.platform !== 'linux')('does not report an unattributed opencode process whose cwd is a staging lane [requires Linux /proc orphan enumeration]', () => {
    const f = fixture('true')
    const staging = join(f.dir, '.claude', 'worktrees', 'wirprobe-1234567890')
    mkdirSync(join(staging, '.lane'), { recursive: true }); writeFileSync(join(staging, '.lane', 'brief.md'), '# brief\n')
    const child = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'opencode', 'run'], { cwd: staging, stdio: 'ignore' })
    spawnSync('sleep', ['0.1'])
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
    expect(watcher.status, watcher.stderr).toBe(0)
    expect(watcher.stdout).not.toContain(`unattributed opencode pid=${child.pid}`)
  })
  it.skipIf(process.platform !== 'linux')('reads supervision records from staging lanes when attributing opencode processes [requires Linux /proc orphan enumeration]', () => {
    const f = fixture('true')
    const supervision = join(f.dir, '.claude', 'worktrees', 'wirprobe-1234567890', '.lane', 'supervision')
    mkdirSync(supervision, { recursive: true }); writeFileSync(join(supervision, '..', 'brief.md'), '# brief\n')
    const child = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'opencode', 'run'], { cwd: f.dir, stdio: 'ignore' })
    writeFileSync(join(supervision, '1-1.json'), JSON.stringify({ runId: '1-1', state: 'launch-failed', childPid: child.pid }))
    spawnSync('sleep', ['0.1'])
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
    expect(watcher.status, watcher.stderr).toBe(0)
    expect(watcher.stdout).not.toContain(`unattributed opencode pid=${child.pid}`)
  })
  it.skipIf(process.platform !== 'linux').each([
    ['separate', (staging: string) => ['opencode', 'run', '--dir', staging]],
    ['equals', (staging: string) => ['opencode', 'run', `--dir=${staging}`]],
  ])('does not report an unattributed opencode process using the %s --dir form for a staging lane [requires Linux /proc orphan enumeration]', (_form, args) => {
    const f = fixture('true')
    const staging = join(f.dir, '.claude', 'worktrees', 'wirprobe-1234567890')
    mkdirSync(join(staging, '.lane'), { recursive: true }); writeFileSync(join(staging, '.lane', 'brief.md'), '# brief\n')
    const child = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', ...args(staging)], { cwd: f.dir, stdio: 'ignore' })
    spawnSync('sleep', ['0.1'])
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
    expect(watcher.status, watcher.stderr).toBe(0)
    expect(watcher.stdout).not.toContain(`unattributed opencode pid=${child.pid}`)
  })
  it.skipIf(process.platform !== 'linux')('does not report an unattributed opencode test fixture process [requires Linux /proc orphan enumeration]', () => {
    const f = fixture('true')
    const script = join(f.dir, 'test', 'fixtures', 'fake-opencode.mjs')
    mkdirSync(join(f.dir, 'test', 'fixtures'), { recursive: true }); writeFileSync(script, 'setTimeout(() => {}, 30000)\n')
    const child = spawnChild(process.execPath, [script, 'opencode', 'run'], { cwd: f.dir, stdio: 'ignore', env: f.env })
    spawnSync('sleep', ['0.1'])
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
    expect(watcher.status, watcher.stderr).toBe(0)
    expect(watcher.stdout).not.toContain(`unattributed opencode pid=${child.pid}`)
  })
  it.skipIf(process.platform !== 'linux')('still warns for an unattributed process in a staging-shaped directory without a lane brief [requires Linux /proc orphan enumeration]', () => {
    const f = fixture('true')
    const unrelated = join(f.dir, '.claude', 'worktrees', 'wirprobe-1234567890')
    mkdirSync(unrelated, { recursive: true })
    const child = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'opencode', 'run'], { cwd: unrelated, stdio: 'ignore' })
    spawnSync('sleep', ['0.1'])
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
    expect(watcher.status, watcher.stderr).toBe(0)
    expect(watcher.stdout).toContain(`WARNING: unattributed opencode pid=${child.pid}`)
  })
  it.skipIf(process.platform !== 'linux')('does not report an executable named opencode from the OS temp directory [requires Linux /proc orphan enumeration]', () => {
    const f = fixture('true')
    const fakeDir = realpathSync(mkdtempSync(join(tmpdir(), 'wt-fake-opencode-'))); roots.push(fakeDir)
    const fake = join(fakeDir, 'opencode'); copyFileSync('/bin/sleep', fake)
    const child = spawnChild(fake, ['30'], { cwd: f.dir, stdio: 'ignore' })
    try {
      spawnSync('sleep', ['0.1'])
      const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
      expect(watcher.status, watcher.stderr).toBe(0)
      expect(watcher.stdout).not.toContain(`unattributed opencode pid=${child.pid}`)
    } finally {
      try { process.kill(child.pid!, 'SIGKILL') } catch {}
    }
  })
  it.skipIf(process.platform !== 'linux')('does not report an opencode shell script from the OS temp directory [requires Linux /proc orphan enumeration]', () => {
    const f = fixture('true')
    const fakeDir = realpathSync(mkdtempSync(join(tmpdir(), 'wt-fake-opencode-'))); roots.push(fakeDir)
    const fake = join(fakeDir, 'opencode'); writeFileSync(fake, '#!/bin/sh\nexec sleep 30\n'); chmodSync(fake, 0o755)
    const child = spawnChild('/bin/sh', [fake, 'run', 'x'], { cwd: f.dir, stdio: 'ignore' })
    try {
      spawnSync('sleep', ['0.1'])
      const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
      expect(watcher.status, watcher.stderr).toBe(0)
      expect(watcher.stdout).not.toContain(`unattributed opencode pid=${child.pid}`)
    } finally {
      try { process.kill(child.pid!, 'SIGKILL') } catch {}
    }
  })
  it.skipIf(process.platform !== 'linux')('reports an unattributed real-shape opencode process [requires Linux /proc orphan enumeration]', () => {
    const f = fixture('true')
    const unknown = join(f.dir, 'unknown'); mkdirSync(unknown)
    const child = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'opencode', 'run', '--dir', unknown], { cwd: f.dir, stdio: 'ignore' })
    try {
      spawnSync('sleep', ['0.1'])
      const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
      expect(watcher.status, watcher.stderr).toBe(0)
      expect(watcher.stdout).toContain(`WARNING: unattributed opencode pid=${child.pid}`)
    } finally {
      try { process.kill(child.pid!, 'SIGKILL') } catch {}
    }
  })
  it.skipIf(process.platform !== 'linux')('still warns when an opencode --dir escapes a staging lane through a symlink [requires Linux /proc orphan enumeration]', () => {
    const f = fixture('true')
    const staging = join(f.dir, '.claude', 'worktrees', 'wirprobe-1234567890')
    const outside = join(f.root, 'outside')
    mkdirSync(join(staging, '.lane'), { recursive: true }); writeFileSync(join(staging, '.lane', 'brief.md'), '# brief\n')
    mkdirSync(outside); symlinkSync(outside, join(staging, 'escape'))
    const child = spawnChild(process.execPath, ['-e', 'setTimeout(() => {}, 30000)', 'opencode', 'run', '--dir', join(staging, 'escape', 'missing')], { cwd: f.dir, stdio: 'ignore' })
    spawnSync('sleep', ['0.1'])
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env })
    expect(watcher.status, watcher.stderr).toBe(0)
    expect(watcher.stdout).toContain(`WARNING: unattributed opencode pid=${child.pid}`)
  })
  it('refuses control from a session other than the recorded owner', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30'); f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const res = run(f, ['--timeout', '1', '--decision-grace', '10']); expect(res.status).toBe(0)
    waitForContent(currentStateFile(f.dir), /decision-needed/)
    const quietWatcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: { ...f.env, CLAUDE_CODE_SESSION_ID: 'other-session' } })
    expect(quietWatcher.stdout).not.toContain('LANE decision-needed')
    const control = spawnSync(process.execPath, [CONTROL, '--dir', f.dir, '--decision', 'extend'], { encoding: 'utf8', env: { ...f.env, CLAUDE_CODE_SESSION_ID: 'other-session' } })
    expect(control.status).toBe(1); expect(control.stderr).toContain('recorded owner')
    process.kill(Number(/pid=(\d+)/.exec(res.stdout)?.[1]), 'SIGTERM')
  })
  it.each(['extend', 'abandon'])('prints a %s command that runs as written outside the plugin repository', (decision) => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30'); f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    isolateWatcherHostCensus(f)
    const res = run(f, ['--timeout', '1', '--decision-grace', '10']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir)
    waitForContent(status, /decision-needed/); waitForVerdict(status, 'decision-needed')
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env, timeout: 30_000 })
    expect(watcher.status, `${watcher.error ?? ''}\n${watcher.stderr}`).toBe(0)
    const command = new RegExp(`${decision} with (node .*? --decision ${decision})(?:,| before)`).exec(watcher.stdout)?.[1]
    expect(command).toBeTruthy()
    const control = spawnSync(command!, { cwd: f.root, shell: true, encoding: 'utf8', env: f.env })
    expect(control.status, control.stderr).toBe(0)
    const state = JSON.parse(readFileSync(currentStateFile(f.dir), 'utf8'))
    if (decision === 'extend') killIdentity({ pid: state.workerPid, argv: state.workerArgv }, 'SIGTERM')
    else expect(state.state).toBe('abandoned')
  }, 60_000)
  it('single-quotes printed commands for spaces, apostrophes, and command substitutions', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const hostile = join(f.root, "work tree ' $(touch INJECTED)")
    mkdirSync(hostile); mkdirSync(join(hostile, '.lane')); writeFileSync(join(hostile, 'brief.md'), '# brief\n')
    f.dir = hostile
    f.env.CLAUDE_CODE_SESSION_ID = 'owner-session'
    const res = run(f, ['--timeout', '1', '--decision-grace', '10']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir)
    waitForContent(status, /decision-needed/); waitForVerdict(status, 'decision-needed')
    const watcher = spawnSync(process.execPath, [WATCHER, '--project', f.dir, '--once'], { encoding: 'utf8', env: f.env, timeout: 30_000 })
    expect(watcher.status, `${watcher.error ?? ''}\n${watcher.stderr}`).toBe(0)
    const command = /extend with (node .*? --decision extend)(?:,| before)/.exec(watcher.stdout)?.[1]
    expect(command).toBeTruthy()
    expect(command).toContain("'\"'\"'")
    expect(spawnSync(command!, { cwd: f.root, shell: true, encoding: 'utf8', env: f.env }).status).toBe(0)
    expect(existsSync(join(f.root, 'INJECTED'))).toBe(false)
    const state = JSON.parse(readFileSync(currentStateFile(f.dir), 'utf8'))
    killIdentity({ pid: state.workerPid, argv: state.workerArgv }, 'SIGTERM')
  }, 60_000)
  it('refuses relaunch as an unknown decision', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    const control = spawnSync(process.execPath, [CONTROL, '--dir', f.dir, '--decision', 'relaunch'], { encoding: 'utf8', env: f.env })
    expect(control.status).toBe(2)
    expect(control.stderr).toContain('required --dir and --decision extend|abandon')
  })
  it('extends and then abandons a pilot lane through control with a real worker', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '1', '--decision-grace', '10', '--owner', 'pilot', '--owner-token', 'pilot-token']); expect(res.status).toBe(0)
    const status = currentStateFile(f.dir); waitForContent(status, /decision-needed/)
    const extend = spawnSync(process.execPath, [CONTROL, '--dir', f.dir, '--decision', 'extend', '--extend', '0.2', '--owner-token', 'pilot-token'], { encoding: 'utf8', env: f.env })
    expect(extend.status, extend.stderr).toBe(0)
    waitForContent(status, /"extensionCount": 1/)
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({ state: 'running', extensionCount: 1 })
    waitForContent(status, /decision-needed/)
    const abandon = spawnSync(process.execPath, [CONTROL, '--dir', f.dir, '--decision', 'abandon', '--owner-token', 'pilot-token'], { encoding: 'utf8', env: f.env })
    expect(abandon.status, abandon.stderr).toBe(0)
    waitForContent(status, /abandoned/)
    expect(JSON.parse(readFileSync(status, 'utf8'))).toMatchObject({ state: 'abandoned', decision: 'abandon' })
    const pid = Number(readFileSync(join(f.dir, 'opencode.pid'), 'utf8').trim())
    const until = Date.now() + 4000; let alive = true
    while (Date.now() < until) { try { process.kill(pid, 0); spawnSync('sleep', ['0.05']) } catch { alive = false; break } }
    expect(alive).toBe(false)
  })
  it('a SIGTERM to the worker takes the opencode process with it and writes EXIT=143 (a killed launcher used to leave the lane running)', () => {
    const f = fixture('echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const worker = Number(/pid=(\d+)/.exec(res.stdout)?.[1])
    const pidFile = join(f.dir, 'opencode.pid'); waitForFile(pidFile)
    const opencodePid = Number(readFileSync(pidFile, 'utf8').trim())
    process.kill(worker, 'SIGTERM')
    const log = join(f.dir, '.lane', 'run.log'); waitFor(log, 4000)
    expect(readFileSync(log, 'utf8')).toMatch(/EXIT=143\n$/)
    const until = Date.now() + 4000; let alive = true
    while (Date.now() < until) { try { process.kill(opencodePid, 0) } catch { alive = false; break } spawnSync('sleep', ['0.05']) }
    expect(alive).toBe(false)
  })
  it('an external SIGTERM after the lane wrote its own EXIT line does not append a second one (a lifecycle group kill used to turn EXIT=0 into EXIT=143)', () => {
    const f = fixture('printf "lane done\\nEXIT=0\\n" >> "$PWD/.lane/run.log"; echo $$ > "$PWD/opencode.pid"; sleep 30')
    const res = run(f, ['--timeout', '60']); expect(res.status).toBe(0)
    const worker = Number(/pid=(\d+)/.exec(res.stdout)?.[1])
    const pidFile = join(f.dir, 'opencode.pid'); waitForFile(pidFile)
    const log = join(f.dir, '.lane', 'run.log')
    waitForContent(log, /^EXIT=0$/m, 4000)
    process.kill(worker, 'SIGTERM')
    const until = Date.now() + 4000
    while (Date.now() < until) { try { process.kill(Number(readFileSync(pidFile, 'utf8').trim()), 0); spawnSync('sleep', ['0.05']) } catch { break } }
    const lines = readFileSync(log, 'utf8').trimEnd().split(/\r?\n/)
    const exitIndex = lines.findIndex((line) => line === 'EXIT=0')
    expect(exitIndex).toBeGreaterThanOrEqual(0)
    expect(lines.filter((line) => /^EXIT=/.test(line))).toEqual(['EXIT=0'])
    expect(lines.slice(exitIndex + 1).some((line) => /\bstage=/.test(line))).toBe(false)
    expect(lines.at(-1)).toBe('EXIT=0')
  })
  it('runs a known variant silently, refuses an unknown variant, and traces a forced unknown variant', () => {
    const f = fixture('printf "%s\\n" "$@" > "$PWD/argv"; printf "# Report\\n" > "$PWD/.lane/report.md"')
    const known = run(f, ['--variant', 'high']); expect(known.status).toBe(0)
    const log = join(f.dir, '.lane', 'run.log'); waitFor(log)
    expect(known.stderr).toBe('')
    expect(readFileSync(join(f.dir, 'argv'), 'utf8')).toMatch(/--variant\nhigh\n/)

    const unknown = run(f, ['--variant', 'future-effort'])
    expect(unknown.status).not.toBe(0)
    expect(unknown.stderr).toContain('future-effort')
    expect(unknown.stderr).toContain('openai/gpt-5.6-luna')
    expect(unknown.stderr).toContain('known variants')
    expect(unknown.stderr).toContain('--allow-unknown-variant')

    const forced = run(f, ['--variant', 'future-effort', '--allow-unknown-variant'])
    expect(forced.status).toBe(0)
    waitFor(log)
    expect(readFileSync(join(f.dir, 'argv'), 'utf8')).toMatch(/--variant\nfuture-effort\n/)
    expect(readFileSync(log, 'utf8')).toContain('variant=future-effort origin=override forced=true')
    expect(readFileSync(join(f.dir, '.lane', 'report.md'), 'utf8')).toContain('variant=future-effort origin=override forced=true')

    const malformed = run(f, ['--variant', 'hi gh']); expect(malformed.status).toBe(2); expect(malformed.stderr).toContain('--variant')
  })
  it('fences Claude Code skills while preserving the opencode argv contract and launch options', () => {
    const f = fixture('printf "%s\\n" "$OPENCODE_DISABLE_CLAUDE_CODE_SKILLS" > "$PWD/claude-skills-fence"; printf "%s\\n" "$@" > "$PWD/argv"')
    f.env.OPENCODE_DISABLE_CLAUDE_CODE_SKILLS = 'false'
    const res = run(f, ['--variant', 'high', '--timeout', '1']); expect(res.status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'claude-skills-fence'), 'utf8')).toBe('true\n')
    const argv = readFileSync(join(f.dir, 'argv'), 'utf8').split('\n')
    expect(argv[1]).toMatch(/^Read and execute the complete brief at .+[/\\]\.lane[/\\]brief-snapshots[/\\]\d+-\d+\.md\.$/)
    expect(argv).toEqual([
      'run',
      argv[1],
      '--auto',
      '--dir',
      f.dir,
      '--model',
      'openai/gpt-5.6-luna',
      '--variant',
      'high',
      '',
    ])
  })
  it('refuses before launch when OpenCode ignores the fence', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.IGNORE_FENCE = '1'
    const res = run(f)
    expect(res.status).toBe(1)
    expect(res.stderr).toBe('OPENCODE_SKILL_FENCE_UNAVAILABLE: the synthetic Claude skill is still listed under the forced fence; update OpenCode or workflow-toolbox before launching.\n')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it('refuses before spawn when effective discovery reports a project-native refused skill', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.EFFECTIVE_SKILLS = '[{"name":"save-memory","location":"/lane/.opencode/skills/save-memory/SKILL.md"}]'
    const res = run(f)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain('save-memory at /lane/.opencode/skills/save-memory/SKILL.md')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })

  it.each(['Save-Memory', 'save_memory', 'SAVE-MEMORY'])('refuses the discovered %s variant before spawn', (name) => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.EFFECTIVE_SKILLS = JSON.stringify([{ name, location: `/lane/.opencode/skills/${name}/SKILL.md` }])
    const res = run(f)
    expect(res.status).toBe(1)
    expect(res.stderr).toContain(`${name} at /lane/.opencode/skills/${name}/SKILL.md`)
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })

  it('drops an inherited OPENCODE_CONFIG before both effective discovery and spawn', () => {
    const f = fixture('printf "run|%s|%s|%s\\n" "$PWD" "$IDENTITY_MARKER" "${OPENCODE_CONFIG-unset}" >> "$IDENTITY_RECORD"; printf spawned > "$PWD/spawned"')
    f.env.IDENTITY_RECORD = join(f.root, 'identity-record')
    f.env.IDENTITY_MARKER = 'same'
    f.env.OPENCODE_CONFIG = join(f.root, 'unsafe.json')
    expect(run(f).status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'spawned'), 'utf8')).toBe('spawned')
    expect(readFileSync(f.env.IDENTITY_RECORD, 'utf8').trim().split('\n').slice(-2)).toEqual([
      `probe|${f.dir}|same|unset`,
      `run|${f.dir}|same|unset`,
    ])
  })
  it('keeps an empty allow-list launchable when the allow half is unavailable', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.INVISIBLE_ALLOW = '1'
    const res = run(f)
    expect(res.status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'spawned'), 'utf8')).toBe('spawned')
  })
  it('refuses requested single-writer, missing, and unavailable allow-list skills before launch', () => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.WT_LANE_SKILLS = 'save-memory'
    expect(run(f).stderr).toContain('save-memory is a single-writer memory/board-writing skill')
    f.env.WT_LANE_SKILLS = 'missing'
    expect(run(f).stderr).toContain('missing: missing-source (skill source is missing: missing)')
    mkdirSync(join(f.config, 'skills', 'allowed'), { recursive: true })
    writeFileSync(join(f.config, 'skills', 'allowed', 'SKILL.md'), '---\nname: allowed\ndescription: allowed\n---\n')
    f.env.WT_LANE_SKILLS = 'allowed'; f.env.INVISIBLE_ALLOW = '1'
    const unavailable = run(f)
    expect(unavailable.status).toBe(1)
    expect(unavailable.stderr).toContain('allow-list half failed for opencode-config-skills-paths')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it.each(['save_memory', 'SAVE-MEMORY'])('refuses requested single-writer variant %s', (name) => {
    const f = fixture('printf spawned > "$PWD/spawned"')
    f.env.WT_LANE_SKILLS = name
    expect(run(f).stderr).toContain('single-writer memory/board-writing skill')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it('passes the materialised mechanism only for requested allowed skills', () => {
    const f = fixture('printf "%s" "$OPENCODE_CONFIG" > "$PWD/opencode-config"')
    mkdirSync(join(f.config, 'skills', 'allowed'), { recursive: true })
    writeFileSync(join(f.config, 'skills', 'allowed', 'SKILL.md'), '---\nname: allowed\ndescription: allowed\n---\n')
    f.env.WT_LANE_SKILLS = 'allowed'
    expect(run(f).status).toBe(0)
    waitFor(join(f.dir, '.lane', 'run.log'))
    expect(readFileSync(join(f.dir, 'opencode-config'), 'utf8')).toBe(join(f.dir, '.lane', 'opencode-skills.json'))
  })
  it('refuses absent consent before spawning', () => {
    const f = fixture('echo spawned > "$PWD/spawned"')
    writeFileSync(join(f.config, 'settings.json'), '{}')
    const res = run(f); expect(res.status).not.toBe(0); expect(res.stderr).toContain('Refused:')
    expect(existsSync(join(f.dir, 'spawned'))).toBe(false)
  })
  it('rejects missing required arguments', () => {
    const f = fixture('true')
    const res = spawnSync(process.execPath, [LAUNCHER, '--model', 'test/model', '--brief', join(f.dir, 'brief.md')], { encoding: 'utf8', env: f.env })
    expect(res.status).toBe(2); expect(res.stderr).toContain('missing required')
  })
  it('writes a redacted environment snapshot and launching session when the worker starts', () => {
    const f = fixture('sleep 0.2')
    delete f.env.CLAUDE_CODE_SESSION_ID
    writeFileSync(join(f.root, 'bin', 'ssh-add'), '#!/bin/sh\nprintf \'ssh-rsa AAAA fingerprint\n\'\nexit 0\n')
    spawnSync('chmod', ['+x', join(f.root, 'bin', 'ssh-add')])
    const res = run(f); expect(res.status).toBe(0)
    const envLog = join(f.dir, '.lane', 'env.log'); waitForFile(envLog)
    const lines = readFileSync(envLog, 'utf8').trim().split('\n')
    expect(lines).toHaveLength(6)
    expect(lines[0]).toBe('CLAUDE_CODE_SESSION_ID=')
    expect(lines[1]).toMatch(/^SSH_AUTH_SOCK=(present|absent)$/)
    expect(lines[2]).toBe('ssh-add -l: exit=0 keys=1')
    expect(lines[3]).toMatch(/^HOME=(present|absent) USER=(present|absent)$/)
    expect(lines[4]).toMatch(/^node=v\d+\.\d+\.\d+$/)
    expect(lines[5]).toMatch(/^at=\d{4}-\d\d-\d\dT.*Z$/)
    expect(readFileSync(envLog, 'utf8')).not.toMatch(/ssh-rsa|fingerprint|AAAA|\/home\//)
  })

  it('records the launching Claude session id and an empty value when absent', () => {
    const withSession = fixture('sleep 0.2')
    withSession.env.CLAUDE_CODE_SESSION_ID = 'session-under-test'
    expect(run(withSession).status).toBe(0)
    const withSessionLog = join(withSession.dir, '.lane', 'env.log'); waitForFile(withSessionLog)
    expect(readFileSync(withSessionLog, 'utf8')).toContain('CLAUDE_CODE_SESSION_ID=session-under-test\n')

    const withoutSession = fixture('sleep 0.2')
    delete withoutSession.env.CLAUDE_CODE_SESSION_ID
    expect(run(withoutSession).status).toBe(0)
    const withoutSessionLog = join(withoutSession.dir, '.lane', 'env.log'); waitForFile(withoutSessionLog)
    expect(readFileSync(withoutSessionLog, 'utf8')).toContain('CLAUDE_CODE_SESSION_ID=\n')
  })
  it('records an ssh-add exit without exposing probe output', () => {
    const f = fixture('sleep 0.2')
    writeFileSync(join(f.root, 'bin', 'ssh-add'), '#!/bin/sh\nexit 2\n')
    spawnSync('chmod', ['+x', join(f.root, 'bin', 'ssh-add')])
    expect(run(f).status).toBe(0)
    const envLog = join(f.dir, '.lane', 'env.log'); waitForFile(envLog)
    expect(readFileSync(envLog, 'utf8')).toContain('ssh-add -l: exit=2 keys=0')
    expect(readFileSync(envLog, 'utf8')).not.toMatch(/ssh-ed25519|SHA256:|secret|AAAA/)
  })
  it('reports keys=0 when ssh-add fails while still printing a sentence', () => {
    const f = fixture('sleep 0.2')
    writeFileSync(join(f.root, 'bin', 'ssh-add'), '#!/bin/sh\nprintf \'The agent has no identities.\\n\'\nexit 1\n')
    spawnSync('chmod', ['+x', join(f.root, 'bin', 'ssh-add')])
    expect(run(f).status).toBe(0)
    const envLog = join(f.dir, '.lane', 'env.log'); waitForFile(envLog)
    expect(readFileSync(envLog, 'utf8')).toContain('ssh-add -l: exit=1 keys=0')
    expect(readFileSync(envLog, 'utf8')).not.toContain('identities')
  })
})
