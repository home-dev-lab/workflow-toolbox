import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { inspectProcess } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const WAITER = join(ROOT, 'plugin/bin/wt-lane-wait.mjs')
const roots: string[] = []
const workers: ReturnType<typeof spawn>[] = []

afterEach(() => {
  for (const worker of workers.splice(0)) {
    if (worker.exitCode !== null) continue
    if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(worker.pid), '/t', '/f'])
    else try { process.kill(-worker.pid!, 'SIGKILL') } catch { /* fixture may already be gone */ }
  }
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 })
})

function fixture(script: string) {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'wt-lane-wait-')))
  roots.push(root)
  const lane = join(root, '.lane')
  mkdirSync(lane)
  const runId = `${process.pid}-${Date.now()}`
  writeFileSync(join(lane, 'run.log'), `LANE_RUN_ID=${runId}\n`)
  const worker = spawn(process.execPath, ['-e', script], { cwd: root, detached: true, stdio: 'ignore' })
  workers.push(worker)
  worker.unref()
  writeFileSync(join(lane, 'pid'), String(worker.pid))
  const identity = inspectProcess(worker.pid!) ?? {
    pid: worker.pid!, argv: [process.execPath, '-e', script], startTime: Date.now(), startTimeApproximate: true,
  }
  const supervision = join(lane, 'supervision')
  mkdirSync(supervision)
  writeFileSync(join(supervision, `${runId}.json`), JSON.stringify({ runId, state: 'running', workerPid: worker.pid, workerArgv: identity.argv, workerStartTime: identity.startTime, workerStartTimeApproximate: identity.startTimeApproximate, childPid: worker.pid, childArgv: identity.argv, childStartTime: identity.startTime, childStartTimeApproximate: identity.startTimeApproximate, worktree: root }))
  writeFileSync(join(supervision, 'current.json'), JSON.stringify({ runId }))
  return { root, lane, pid: worker.pid! }
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [WAITER, '--dir', root, '--poll', '0.02', '--timeout', '30', ...args], {
    encoding: 'utf8',
  })
}

const terminalUpdate = "const file = fs.readdirSync('.lane/supervision').find((name) => /^\\d+-\\d+\\.json$/.test(name)); const state = JSON.parse(fs.readFileSync('.lane/supervision/' + file)); fs.writeFileSync('.lane/supervision/' + file, JSON.stringify({ ...state, state: 'exited', exit: 137 }));"

describe('wt-lane-wait', () => {
  it('waits for the pid and accepts EXIT only on the last log line', () => {
    const f = fixture("const fs = require('node:fs'); fs.appendFileSync('.lane/run.log', 'echo EXIT=$? >> .lane/test.log\\n'); setTimeout(() => { fs.appendFileSync('.lane/run.log', 'EXIT=7\\n'); setTimeout(() => {}, 80) }, 120)")
    const result = run(f.root)
    expect(result.status).toBe(7)
    expect(result.stdout.trim()).toMatch(/^LANE DONE exit=7 report=none log=.*run\.log$/)
    expect(result.stdout).not.toContain('echo EXIT=')
  })

  it.each([0, 9])('propagates lane exit %i', (exit) => {
    const f = fixture(`const fs = require('node:fs'); setTimeout(() => { fs.appendFileSync('.lane/run.log', 'EXIT=${exit}\\n'); setTimeout(() => {}, 80) }, 80)`)
    const result = run(f.root)
    expect(result.status).toBe(exit)
  })

  it('ignores a stale exit marker while a nonterminal lane is alive', () => {
    const f = fixture("const fs = require('node:fs'); fs.appendFileSync('.lane/run.log', 'EXIT=9\\n'); setTimeout(() => {}, 30_000)")
    const result = run(f.root, '--timeout', '0.08')
    expect(result.status).toBe(124)
    expect(result.stdout.trim()).toBe('LANE TIMEOUT exit=124')
  })

  it('never accepts an exit marker from an earlier run', () => {
    const f = fixture("const fs = require('node:fs'); setTimeout(() => { const file = fs.readdirSync('.lane/supervision').find((name) => /^\\d+-\\d+\\.json$/.test(name)); const state = JSON.parse(fs.readFileSync('.lane/supervision/' + file)); fs.writeFileSync('.lane/supervision/' + file, JSON.stringify({ ...state, state: 'exited', exit: 7 })); setTimeout(() => fs.writeFileSync('.lane/run.log', 'LANE_RUN_ID=' + state.runId + '\\nEXIT=7\\n'), 80); }, 40)")
    writeFileSync(join(f.lane, 'run.log'), 'LANE_RUN_ID=earlier-run\nEXIT=0\n')
    const result = run(f.root)
    expect(result.status).toBe(7)
    expect(result.stdout.trim()).toMatch(/^LANE DONE exit=7/)
  })

  it('prints a recorded OOM cause with the lane exit', () => {
    const f = fixture("const fs = require('node:fs'); setTimeout(() => { const file = fs.readdirSync('.lane/supervision').find((name) => /^\\d+-\\d+\\.json$/.test(name)); const state = JSON.parse(fs.readFileSync('.lane/supervision/' + file)); fs.writeFileSync('.lane/supervision/' + file, JSON.stringify({ ...state, state: 'exited', exit: 137, killedBy: { signal: 'SIGKILL', cause: 'kernel-oom' } })); fs.appendFileSync('.lane/run.log', 'KILLED_BY=kernel-oom signal SIGKILL\\nEXIT=137\\n'); }, 80)")
    const result = run(f.root)
    expect(result.status).toBe(137)
    expect(result.stdout.trim()).toContain(process.platform === 'win32'
      ? 'cause=unavailable-on-this-platform signal=unavailable'
      : 'cause=kernel-oom signal=SIGKILL')
  })

  it('waits for an exit marker published after the terminal supervision record', () => {
    const f = fixture(`const fs = require('node:fs'); setTimeout(() => { ${terminalUpdate} setTimeout(() => fs.appendFileSync('.lane/run.log', 'EXIT=137\\n'), 100); }, 80)`)
    const result = run(f.root)
    expect(result.status).toBe(137)
    expect(result.stdout.trim()).toMatch(/^LANE DONE exit=137/)
  })

  it('accepts a published marker from a terminal record while the worker is alive', () => {
    const f = fixture(`const fs = require('node:fs'); setTimeout(() => { ${terminalUpdate} fs.appendFileSync('.lane/run.log', 'EXIT=137\\n'); setTimeout(() => {}, 30_000); }, 40)`)
    const result = run(f.root)
    expect(result.status).toBe(137)
    expect(result.stdout.trim()).toMatch(/^LANE DONE exit=137/)
  })

  it('accepts a published marker from a terminal record after the worker dies', () => {
    const f = fixture(`const fs = require('node:fs'); setTimeout(() => { ${terminalUpdate} fs.appendFileSync('.lane/run.log', 'EXIT=137\\n'); }, 40)`)
    const result = run(f.root)
    expect(result.status).toBe(137)
    expect(result.stdout.trim()).toMatch(/^LANE DONE exit=137/)
  })

  it('bounds a missing marker after terminal supervision while the worker is alive', () => {
    const f = fixture(`const fs = require('node:fs'); setTimeout(() => { ${terminalUpdate} setTimeout(() => {}, 30_000); }, 40)`)
    const result = run(f.root, '--timeout', '0.12')
    expect(result.status).toBe(1)
    expect(result.stdout.trim()).toBe('LANE DIED exit=unknown')
  })

  it('bounds a missing marker after terminal supervision when the worker is dead', () => {
    const f = fixture(`const fs = require('node:fs'); setTimeout(() => { ${terminalUpdate} }, 40)`)
    const result = run(f.root, '--timeout', '0.12')
    expect(result.status).toBe(1)
    expect(result.stdout.trim()).toBe('LANE DIED exit=unknown')
  })

  it('waits for termination publication after the worker and child are gone', () => {
    const f = fixture("const fs = require('node:fs'); const cp = require('node:child_process'); setTimeout(() => { const file = fs.readdirSync('.lane/supervision').find((name) => /^\\d+-\\d+\\.json$/.test(name)); const state = JSON.parse(fs.readFileSync('.lane/supervision/' + file)); fs.writeFileSync('.lane/supervision/' + file, JSON.stringify({ ...state, state: 'terminating' })); const code = `const fs = require('node:fs'); setTimeout(() => { const state = JSON.parse(fs.readFileSync(process.argv[1])); fs.writeFileSync(process.argv[1], JSON.stringify({ ...state, state: 'abandoned' })); fs.appendFileSync(process.argv[2], 'EXIT=126\\\\n') }, 80)`; const child = cp.spawn(process.execPath, ['-e', code, '.lane/supervision/' + file, '.lane/run.log'], { detached: true, stdio: 'ignore' }); child.unref(); }, 40)")
    const result = run(f.root)
    expect(result.status).toBe(126)
    expect(result.stdout.trim()).toMatch(/^LANE DONE exit=126/)
  })

  it('returns 124 when the lane does not finish before timeout', () => {
    const f = fixture('setTimeout(() => {}, 30_000)')
    const result = run(f.root, '--timeout', '0.08')
    expect(result.status).toBe(124)
    try {
      if (process.platform === 'win32') spawnSync('taskkill.exe', ['/pid', String(f.pid), '/t', '/f'])
      else process.kill(-f.pid, 'SIGTERM')
    } catch { /* fixture may already be gone */ }
  })

  it('reports a dead lane without inventing an exit code', () => {
    const f = fixture('')
    rmSync(join(f.lane, 'run.log'))
    const result = run(f.root)
    expect(result.status).toBe(1)
    expect(result.stdout.trim()).toMatch(/^LANE DIED exit=unknown$/)
  })

  it('accepts a published marker from a dead lane with a nonterminal record', () => {
    const f = fixture("const fs = require('node:fs'); fs.appendFileSync('.lane/run.log', 'EXIT=9\\n')")
    const result = run(f.root)
    expect(result.status).toBe(9)
    expect(result.stdout.trim()).toMatch(/^LANE DONE exit=9/)
  })

  it.each(['256', '-1', '9'.repeat(400)])('maps unsupported lane exit %s to process failure without throwing', (exit) => {
    const f = fixture(`const fs = require('node:fs'); fs.appendFileSync('.lane/run.log', 'EXIT=${exit}\\n')`)
    const result = run(f.root)
    expect(result.status).toBe(1)
    expect(result.stdout.trim()).toMatch(new RegExp(`^LANE DONE exit=${exit} `))
    expect(result.stderr).toBe('')
  })

  it('accepts the current run marker after its supervision record disappears', () => {
    const f = fixture("const fs = require('node:fs'); setTimeout(() => { const file = fs.readdirSync('.lane/supervision').find((name) => /^\\d+-\\d+\\.json$/.test(name)); fs.rmSync('.lane/supervision/current.json'); fs.rmSync('.lane/supervision/' + file); setTimeout(() => fs.appendFileSync('.lane/run.log', 'EXIT=7\\n'), 60); setTimeout(() => {}, 80); }, 60)")
    const result = run(f.root)
    expect(result.status).toBe(7)
    expect(result.stdout.trim()).toMatch(/^LANE DONE exit=7/)
  })

  it('reports report byte size without reading or printing the log body', () => {
    const f = fixture("const fs = require('node:fs'); setTimeout(() => { fs.appendFileSync('.lane/run.log', 'EXIT=0\\n'); setTimeout(() => {}, 80) }, 80)")
    writeFileSync(join(f.lane, 'report.md'), 'report')
    const result = run(f.root)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toContain('report=6')
    expect(existsSync(join(f.lane, 'run.log'))).toBe(true)
    expect(readFileSync(join(f.lane, 'run.log'), 'utf8')).toContain('EXIT=0')
  })
})
