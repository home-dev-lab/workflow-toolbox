import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { inspectProcess } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'

const ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const WAITER = join(ROOT, 'plugin/bin/wt-lane-wait.mjs')
const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(script: string) {
  const root = mkdtempSync(join(tmpdir(), 'wt-lane-wait-'))
  roots.push(root)
  const lane = join(root, '.lane')
  mkdirSync(lane)
  writeFileSync(join(lane, 'run.log'), '')
  const worker = spawn('sh', ['-c', script], { cwd: root, detached: true, stdio: 'ignore' })
  worker.unref()
  writeFileSync(join(lane, 'pid'), String(worker.pid))
  const runId = `${worker.pid}-1`
  const identity = inspectProcess(worker.pid!) ?? { argv: ['sh', '-c', script], startTime: 0 }
  const supervision = join(lane, 'supervision')
  mkdirSync(supervision)
  writeFileSync(join(supervision, `${runId}.json`), JSON.stringify({ runId, state: 'running', workerPid: worker.pid, workerArgv: identity.argv, workerStartTime: identity.startTime, childPid: worker.pid, childArgv: identity.argv, childStartTime: identity.startTime, worktree: root }))
  writeFileSync(join(supervision, 'current.json'), JSON.stringify({ runId }))
  return { root, lane, pid: worker.pid! }
}

function run(root: string, ...args: string[]) {
  return spawnSync(process.execPath, [WAITER, '--dir', root, '--poll', '0.02', '--timeout', '1', ...args], {
    encoding: 'utf8',
  })
}

describe('wt-lane-wait', () => {
  it('waits for the pid and accepts EXIT only on the last log line', () => {
    const f = fixture("printf '%s\\n' 'echo EXIT=$? >> .lane/test.log' >> .lane/run.log; sleep 0.12; printf 'EXIT=7\\n' >> .lane/run.log; sleep 0.08")
    const result = run(f.root)
    expect(result.status).toBe(7)
    expect(result.stdout.trim()).toMatch(/^LANE DONE exit=7 report=none log=.*run\.log$/)
    expect(result.stdout).not.toContain('echo EXIT=')
  })

  it.each([0, 9])('propagates lane exit %i', (exit) => {
    const f = fixture(`sleep 0.08; printf 'EXIT=${exit}\\n' >> .lane/run.log; sleep 0.08`)
    const result = run(f.root)
    expect(result.status).toBe(exit)
  })

  it('returns 124 when the lane does not finish before timeout', () => {
    const f = fixture('sleep 30')
    const result = run(f.root, '--timeout', '0.08')
    expect(result.status).toBe(124)
    try { process.kill(-f.pid, 'SIGTERM') } catch { /* fixture may already be gone */ }
  })

  it('reports a dead lane without inventing an exit code', () => {
    const f = fixture('true')
    rmSync(join(f.lane, 'run.log'))
    const result = run(f.root)
    expect(result.status).toBe(1)
    expect(result.stdout.trim()).toMatch(/^LANE DIED exit=unknown$/)
  })

  it('reports report byte size without reading or printing the log body', () => {
    const f = fixture("sleep 0.08; printf 'EXIT=0\\n' >> .lane/run.log; sleep 0.08")
    writeFileSync(join(f.lane, 'report.md'), 'report')
    const result = run(f.root)
    expect(result.status).toBe(0)
    expect(result.stdout.trim()).toContain('report=6')
    expect(existsSync(join(f.lane, 'run.log'))).toBe(true)
    expect(readFileSync(join(f.lane, 'run.log'), 'utf8')).toContain('EXIT=0')
  })
})
