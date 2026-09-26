import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { bindPilotDecision, decidePilotRun, displayedDecisionStateRoot, initializePilotDecisionStore, pilotDecisionCommand, pilotDecisionStateRoot, readPilotDecisions, registerPilotDecisionRequest } from '../../../../plugin/bin/lib/host/pilot-decision-store.mjs'

const CLI = fileURLToPath(new URL('../../../../plugin/bin/wt-pilot-runner.mjs', import.meta.url))

describe('pilot parent decision store', () => {
  it('accepts only a registered criterion and exposes one shared atomic record', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-pilot-decisions-'))
    const file = initializePilotDecisionStore('card-123', { root })
    registerPilotDecisionRequest(file, { requestId: 'request-1', criteria: [2], deadline: 10_000 })

    expect(() => decidePilotRun({ runId: 'card-123', criterion: 1, reading: 'forged', root })).toThrow('no open decision request for DoD 1')
    decidePilotRun({ runId: 'card-123', criterion: 2, reading: 'literal parent reading', root, decidedAt: 0 })

    expect(readPilotDecisions(file)).toEqual([{ requestId: 'request-1', criterion: 2, reading: 'literal parent reading', decidedAt: '1970-01-01T00:00:00.000Z', boundAt: '1970-01-01T00:00:00.000Z' }])
    expect(() => decidePilotRun({ runId: 'card-123', criterion: 2, reading: 'overwritten', root })).toThrow('already bound (parent)')
    expect(readFileSync(file, 'utf8')).not.toContain('.tmp')
  })

  it('writes through the public decide CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-pilot-cli-'))
    const file = initializePilotDecisionStore('card-456', { root })
    registerPilotDecisionRequest(file, { requestId: 'request-2', criteria: [1], deadline: Date.now() + 60_000 })
    const result = spawnSync(process.execPath, [CLI, 'decide', '--run', 'card-456', '--dod', '1', '--reading', 'parent via cli', '--state-root', root], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(file).toBe(join(root, 'card-456', 'dod-decisions.json'))
    expect(readPilotDecisions(file)[0]).toMatchObject({ criterion: 1, reading: 'parent via cli' })
  })

  it('creates the lock directory for a first decision in a fresh state root', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'wt-pilot-fresh-')), 'new-state')
    expect(existsSync(root)).toBe(false)
    expect(existsSync(join(root, 'first'))).toBe(false)
    const file = initializePilotDecisionStore('first', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: Date.now() + 60_000 })
    // The store, not the CLI or caller, prepares the directory before taking its first lock.
    expect(decidePilotRun({ runId: 'first', criterion: 1, reading: 'first answer', root }).file).toBe(file)
    expect(existsSync(dirname(file))).toBe(true)
  })

  it('resolves host state roots on Linux, macOS, and Windows', () => {
    expect(pilotDecisionStateRoot({ platform: 'linux', env: { XDG_STATE_HOME: '/state' }, home: '/home/u' })).toBe(posix.join('/state', 'workflow-toolbox', 'pilot-runs'))
    expect(pilotDecisionStateRoot({ platform: 'darwin', env: {}, home: '/Users/u' })).toBe(posix.join('/Users/u', 'Library', 'Application Support', 'workflow-toolbox', 'pilot-runs'))
    expect(pilotDecisionStateRoot({ platform: 'win32', env: { LOCALAPPDATA: 'C:\\Users\\u\\AppData\\Local' }, home: 'C:\\Users\\u' })).toBe(win32.join('C:\\Users\\u\\AppData\\Local', 'workflow-toolbox', 'pilot-runs'))
  })

  it('refuses a run id that could escape the state root', () => {
    expect(() => initializePilotDecisionStore('../lane-forgery', { root: tmpdir() })).toThrow('invalid pilot run id')
    for (const id of ['', '.', '..']) expect(() => initializePilotDecisionStore(id, { root: tmpdir() })).toThrow('invalid pilot run id')
  })

  it('refuses late answers and answers after a fallback binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-decision-late-'))
    const file = initializePilotDecisionStore('late', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1, 2], deadline: 100 })
    expect(() => decidePilotRun({ runId: 'late', criterion: 1, reading: 'late', decidedAt: 101, root })).toThrow('late: deadline 1970-01-01T00:00:00.100Z')
    bindPilotDecision(file, { requestId: 'r', criterion: 2, source: 'fallback', at: 100 })
    expect(() => decidePilotRun({ runId: 'late', criterion: 2, reading: 'late', decidedAt: 100, root })).toThrow('already bound (fallback) at')
  })

  it('quotes both shell dialects and includes a non-default state root', () => {
    expect(pilotDecisionCommand('/a b/runner.mjs', 'run 1', '/a b/node', '/state dir', 'linux')).toContain("'/a b/node' '/a b/runner.mjs' decide --run 'run 1' --state-root '/state dir'")
    expect(pilotDecisionCommand('C:\\Program Files\\runner.mjs', 'run', 'C:\\Program Files\\node.exe', 'D:\\state dir', 'win32')).toMatch(/^'C:\\Program Files\\node.exe' .*--state-root 'D:\\state dir'\nPowerShell: & 'C:\\Program Files\\node.exe' /)
    const root = mkdtempSync(join(tmpdir(), 'wt-state root-'))
    const file = initializePilotDecisionStore('quoted', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: Date.now() + 60_000 })
    const result = spawnSync(process.execPath, [CLI, 'decide', '--run', 'quoted', '--dod', '1', '--reading', 'yes', '--state-root', root], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(readPilotDecisions(file)[0]).toMatchObject({ reading: 'yes' })
  })

  it('prints two separately copyable complete Windows commands', () => {
    expect(pilotDecisionCommand('C:\\runner.mjs', 'run', 'C:\\node.exe', 'D:\\state', 'win32', ' --dod 2 --reading <text>')).toBe(
      "'C:\\node.exe' 'C:\\runner.mjs' decide --run 'run' --state-root 'D:\\state' --dod 2 --reading <text>\nPowerShell: & 'C:\\node.exe' 'C:\\runner.mjs' decide --run 'run' --state-root 'D:\\state' --dod 2 --reading <text>",
    )
  })

  it('prints the root even when XDG_STATE_HOME supplied the computed default', () => {
    const env = { XDG_STATE_HOME: '/custom/state' }
    const root = pilotDecisionStateRoot({ platform: 'linux', env, home: '/home/u' })
    expect(displayedDecisionStateRoot(root, root, { platform: 'linux', env })).toBe(root)
    expect(pilotDecisionCommand('/runner', 'run', '/node', displayedDecisionStateRoot(root, root, { platform: 'linux', env }), 'linux', ' --dod 1 --reading yes')).toContain("--state-root '/custom/state/workflow-toolbox/pilot-runs' --dod 1 --reading yes")
    expect(displayedDecisionStateRoot(root, root, { platform: 'linux', env: {} })).toBeNull()
    expect(displayedDecisionStateRoot(root, root, { platform: 'linux', env: {}, injected: true })).toBe(root)
  })

  it('removes a newly opened lock if writing its owner fails', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-write-fail-'))
    const file = join(root, 'run', 'dod-decisions.json')
    expect(() => initializePilotDecisionStore('run', { root, lockOptions: {
      fs: { ...fs, writeFileSync: () => { throw new Error('ENOSPC') } },
    } })).toThrow('ENOSPC')
    expect(existsSync(`${file}.lock`)).toBe(false)
  })

  it('does not overwrite a new writer when two reclaimers interleave with writers B and C', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-reclaim-race-'))
    const file = join(root, 'run', 'dod-decisions.json')
    fs.mkdirSync(dirname(file))
    const lock = `${file}.lock`
    const record = (token: string, pid: number) => JSON.stringify({ token, pid, start: pid })
    writeFileSync(lock, record('dead', 400))
    let switched = false
    let cAcquired = false
    const injected = {
      ...fs,
      readFileSync: ((path: fs.PathLike, ...args: unknown[]) => {
        const observed = fs.readFileSync(path, ...args as [BufferEncoding])
        if (path === lock && !switched) {
          switched = true
          // Reclaimer 2 removes the dead inode; B acquires before A renames.
          fs.renameSync(lock, `${lock}.removed`)
          writeFileSync(lock, record('B', 500))
        }
        return observed
      }) as typeof fs.readFileSync,
      linkSync: (source: fs.PathLike, target: fs.PathLike) => {
        if (!cAcquired) {
          cAcquired = true
          // C wins the vacant pathname during A's attempted restoration. It must wait
          // for displaced B before entering its own update.
          writeFileSync(lock, record('C', 600), { flag: 'wx' })
        }
        fs.linkSync(source, target)
      },
    }
    expect(() => initializePilotDecisionStore('run', { root, lockOptions: {
      fs: injected, token: 'A', pid: 700, startTime: (pid: number) => pid,
      pidExists: (pid: number) => pid !== 400,
      now: (() => { let n = 0; return () => n += 1000 })(), pause: () => {},
    } })).toThrow('timed out')
    expect(cAcquired).toBe(true)
    expect(existsSync(file)).toBe(false) // A never entered while B's displaced owner remained live.
    expect(readFileSync(lock, 'utf8')).toBe(record('C', 600))
  })

  it('never reclaims a live owner merely because its lock is old', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-live-lock-'))
    const file = join(root, 'run', 'dod-decisions.json')
    fs.mkdirSync(dirname(file))
    const lock = `${file}.lock`
    writeFileSync(lock, JSON.stringify({ token: 'B', pid: 500, start: 500 }))
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    expect(() => initializePilotDecisionStore('run', { root, lockOptions: { pidExists: () => true, startTime: () => 500, now: (() => { let n = 0; return () => n += 36_000 })(), pause: () => {} } })).toThrow('timed out')
    expect(readFileSync(lock, 'utf8')).toContain('"token":"B"')
  })

  it('uses the age fallback for an old unreadable owner record', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-unreadable-lock-'))
    const file = join(root, 'run', 'dod-decisions.json')
    fs.mkdirSync(dirname(file))
    const lock = `${file}.lock`
    writeFileSync(lock, 'unreadable')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    let reclaimed = false
    const injected = {
      ...fs,
      openSync: ((path: fs.PathLike, ...args: unknown[]) => {
        const fd = fs.openSync(path, ...args as [string])
        if (path === lock) reclaimed = true
        return fd
      }) as typeof fs.openSync,
      readFileSync: ((path: fs.PathLike, ...args: unknown[]) => {
        if ((path === lock && !reclaimed) || String(path).endsWith('.stale')) throw Object.assign(new Error('unreadable'), { code: 'EACCES' })
        return fs.readFileSync(path, ...args as [BufferEncoding])
      }) as typeof fs.readFileSync,
    }
    initializePilotDecisionStore('run', { root, lockOptions: { fs: injected } })
    expect(existsSync(lock)).toBe(false)
  })

  it('keeps a new lock holder outside the critical section until a displaced live writer exits', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-displaced-owner-'))
    const file = join(root, 'run', 'dod-decisions.json')
    fs.mkdirSync(dirname(file))
    const lock = `${file}.lock`
    const displaced = `${lock}.A.stale`
    writeFileSync(displaced, JSON.stringify({ token: 'B', pid: 500, start: 500 }))
    let inside = 1
    let maximum = inside
    let pauses = 0
    initializePilotDecisionStore('run', { root, lockOptions: {
      token: 'C', pid: 600, startTime: (pid: number) => pid, pidExists: () => true,
      pause: () => { pauses++; inside--; fs.rmSync(displaced) },
    } })
    inside++
    maximum = Math.max(maximum, inside)
    expect(pauses).toBe(1)
    expect(maximum).toBe(1)
  })

  it('preserves both decisions from simultaneous CLI processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-pilot-concurrent-'))
    const file = initializePilotDecisionStore('concurrent', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1, 2], deadline: Date.now() + 60_000 })
    const run = (number: number) => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [CLI, 'decide', '--run', 'concurrent', '--dod', String(number), '--reading', `answer ${number}`, '--state-root', root])
      child.on('exit', resolve)
    })
    expect(await Promise.all([run(1), run(2)])).toEqual([0, 0])
    expect(readPilotDecisions(file).map((entry: { criterion: number }) => entry.criterion).sort()).toEqual([1, 2])
  })

  it('reclaims a stale exclusive lock and preserves the update', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-stale-lock-'))
    const file = initializePilotDecisionStore('stale', { root })
    const lock = `${file}.lock`
    writeFileSync(lock, 'abandoned')
    const old = new Date(Date.now() - 60_000)
    utimesSync(lock, old, old)
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: Date.now() + 60_000 })
    expect(existsSync(lock)).toBe(false)
    expect(decidePilotRun({ runId: 'stale', criterion: 1, reading: 'preserved', root }).decision.reading).toBe('preserved')
  })
  it('keeps a replacement lock owned by another process when releasing', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-owner-lock-'))
    const file = initializePilotDecisionStore('owner', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: 100 })
    decidePilotRun({ runId: 'owner', criterion: 1, reading: 'answer', root, now: () => {
      writeFileSync(`${file}.lock`, 'new-owner-token')
      return 50
    } })
    expect(readFileSync(`${file}.lock`, 'utf8')).toBe('new-owner-token')
  })
  it('returns the previously recorded binding rather than overwriting it', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-winner-'))
    const file = initializePilotDecisionStore('winner', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: 100 })
    decidePilotRun({ runId: 'winner', criterion: 1, reading: 'parent', root, now: () => 100 })
    expect(bindPilotDecision(file, { requestId: 'r', criterion: 1, source: 'fallback', at: 101 })).toMatchObject({ source: 'parent', reading: 'parent' })
  })
})
