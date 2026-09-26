import { spawn, spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join, posix, win32 } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { bindPilotDecision, decidePilotRun, displayedDecisionStateRoot, initializePilotDecisionStore, pilotDecisionCommand, pilotDecisionStateRoot, readPilotDecisions, registerPilotDecisionRequest, unregisterPilotDecisionRequest } from '../../../../plugin/bin/lib/host/pilot-decision-store.mjs'

const CLI = fileURLToPath(new URL('../../../../plugin/bin/wt-pilot-runner.mjs', import.meta.url))
const PROCESS = fileURLToPath(new URL('./fixtures/pilot-decision-process.mjs', import.meta.url))
const WITHDRAW = fileURLToPath(new URL('./fixtures/pilot-decision-withdraw.mjs', import.meta.url))

describe('pilot parent decision store', () => {
  it('accepts only a registered criterion and exposes one shared atomic record', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-pilot-decisions-'))
    const file = initializePilotDecisionStore('card-123', { root })
    registerPilotDecisionRequest(file, { requestId: 'request-1', criteria: [2], deadline: 10_000 })

    expect(() => decidePilotRun({ runId: 'card-123', requestId: 'request-1', criterion: 1, reading: 'forged', root })).toThrow('no open decision request for DoD 1')
    decidePilotRun({ runId: 'card-123', requestId: 'request-1', criterion: 2, reading: 'literal parent reading', root, decidedAt: 0 })

    expect(readPilotDecisions(file)).toEqual([{ requestId: 'request-1', criterion: 2, reading: 'literal parent reading', decidedAt: '1970-01-01T00:00:00.000Z', boundAt: '1970-01-01T00:00:00.000Z' }])
    expect(() => decidePilotRun({ runId: 'card-123', requestId: 'request-1', criterion: 2, reading: 'overwritten', root, decidedAt: 1 })).toThrow('already bound (parent)')
    expect(readFileSync(file, 'utf8')).not.toContain('.tmp')
  })

  it('writes through the public decide CLI', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-pilot-cli-'))
    const file = initializePilotDecisionStore('card-456', { root })
    registerPilotDecisionRequest(file, { requestId: 'request-2', criteria: [1], deadline: Date.now() + 60_000 })
    const result = spawnSync(process.execPath, [CLI, 'decide', '--run', 'card-456', '--request', 'request-2', '--dod', '1', '--reading', 'parent via cli', '--state-root', root], { encoding: 'utf8' })
    expect(result.status, result.stderr).toBe(0)
    expect(file).toBe(join(root, 'card-456', 'dod-decisions.json'))
    expect(readPilotDecisions(file)[0]).toMatchObject({ criterion: 1, reading: 'parent via cli' })
  })

  it('creates the state directories for a first decision in a fresh state root', () => {
    const root = join(mkdtempSync(join(tmpdir(), 'wt-pilot-fresh-')), 'new-state')
    expect(existsSync(root)).toBe(false)
    expect(existsSync(join(root, 'first'))).toBe(false)
    const file = initializePilotDecisionStore('first', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: Date.now() + 60_000 })
    // The store prepares both record directories.
    expect(decidePilotRun({ runId: 'first', requestId: 'r', criterion: 1, reading: 'first answer', root }).file).toBe(file)
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
    expect(() => decidePilotRun({ runId: 'late', requestId: 'r', criterion: 1, reading: 'late', decidedAt: 101, root })).toThrow('late: deadline 1970-01-01T00:00:00.100Z')
    bindPilotDecision(file, { requestId: 'r', criterion: 2, source: 'fallback', at: 100 })
    expect(() => decidePilotRun({ runId: 'late', requestId: 'r', criterion: 2, reading: 'late', decidedAt: 100, root })).toThrow('already bound (fallback) at')
  })

  it('quotes both shell dialects and includes a non-default state root', () => {
    expect(pilotDecisionCommand('/a b/runner.mjs', 'run 1', '/a b/node', '/state dir', 'linux')).toContain("'/a b/node' '/a b/runner.mjs' decide --run 'run 1' --state-root '/state dir'")
    expect(pilotDecisionCommand('C:\\Program Files\\runner.mjs', 'run', 'C:\\Program Files\\node.exe', 'D:\\state dir', 'win32')).toMatch(/^'C:\\Program Files\\node.exe' .*--state-root 'D:\\state dir'\nPowerShell: & 'C:\\Program Files\\node.exe' /)
    const root = mkdtempSync(join(tmpdir(), 'wt-state root-'))
    const file = initializePilotDecisionStore('quoted', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: Date.now() + 60_000 })
    const result = spawnSync(process.execPath, [CLI, 'decide', '--run', 'quoted', '--request', 'r', '--dod', '1', '--reading', 'yes', '--state-root', root], { encoding: 'utf8' })
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

  it('keeps request identifiers and criteria distinct even when punctuation would sanitize alike', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-request-names-'))
    const file = initializePilotDecisionStore('names', { root })
    registerPilotDecisionRequest(file, { requestId: 'a.b', criteria: [1], deadline: 100 })
    registerPilotDecisionRequest(file, { requestId: 'a-b', criteria: [2], deadline: 100 })
    bindPilotDecision(file, { requestId: 'a.b', criterion: 1, source: 'fallback', at: 1 })
    bindPilotDecision(file, { requestId: 'a-b', criterion: 2, source: 'fallback', at: 1 })
    expect(fs.readdirSync(join(dirname(file), 'bindings'))).toHaveLength(2)
    expect(fs.readdirSync(join(dirname(file), 'requests'))).toHaveLength(2)
    expect(() => bindPilotDecision(file, { requestId: 'a.b', criterion: '../2', source: 'fallback', at: 1 })).toThrow('invalid pilot decision criterion')
  })

  it('ignores an answer bound to a rolled-back request and allows a new request', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-rollback-'))
    const file = initializePilotDecisionStore('rollback', { root })
    registerPilotDecisionRequest(file, { requestId: 'old', criteria: [1], deadline: 100 })
    decidePilotRun({ runId: 'rollback', requestId: 'old', criterion: 1, reading: 'old', root, decidedAt: 1 })
    unregisterPilotDecisionRequest(file, { requestId: 'old', criteria: [1] })
    expect(() => decidePilotRun({ runId: 'rollback', requestId: 'old', criterion: 1, reading: 'invalid', root, decidedAt: 2 })).toThrow('no open')
    registerPilotDecisionRequest(file, { requestId: 'new', criteria: [1], deadline: 100 })
    decidePilotRun({ runId: 'rollback', requestId: 'new', criterion: 1, reading: 'new', root, decidedAt: 2 })
    expect(readPilotDecisions(file).map((decision: { requestId: string }) => decision.requestId).sort()).toEqual(['new', 'old'])
  })

  it('refuses unsupported links without leaving a binding', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-no-links-'))
    const file = initializePilotDecisionStore('no-links', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: 100 })
    const noLinks = { ...fs, linkSync: () => { throw Object.assign(new Error('unsupported'), { code: 'EPERM' }) } }
    expect(() => decidePilotRun({ runId: 'no-links', requestId: 'r', criterion: 1, reading: 'winner', root, decidedAt: 1, bindingOptions: { fs: noLinks } })).toThrow(/pilot decisions need hard links.*EPERM/)
    expect(fs.readdirSync(join(dirname(file), 'bindings'))).toEqual([])
  })
  it('reports corrupt bindings independently of healthy decisions', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-corrupt-'))
    const file = initializePilotDecisionStore('corrupt', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: 100 })
    decidePilotRun({ runId: 'corrupt', requestId: 'r', criterion: 1, reading: 'healthy', root, decidedAt: 1 })
    writeFileSync(join(dirname(file), 'bindings', 'bad.json'), '{')
    const records = readPilotDecisions(file)
    expect(records).toContainEqual(expect.objectContaining({ reading: 'healthy' }))
    expect(records).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ path: expect.stringContaining('bad.json'), code: 'CORRUPT' }) }))
  })
  it('refuses a second owner of one run directory', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-owner-'))
    initializePilotDecisionStore('owned', { root })
    expect(() => initializePilotDecisionStore('owned', { root })).toThrow(/already exists|already owned/)
  })
  it('reports withdrawal after publication rather than success', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-withdraw-'))
    const file = initializePilotDecisionStore('withdraw', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: 100 })
    expect(() => decidePilotRun({ runId: 'withdraw', requestId: 'r', criterion: 1, reading: 'answer', root, decidedAt: 1, bindingOptions: { afterTempWrite: () => unregisterPilotDecisionRequest(file, { requestId: 'r', criteria: [1] }) } })).toThrow('request withdrawn after your decision was recorded')
  })
  it('exits nonzero without a success receipt when the CLI request is withdrawn after link', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-withdraw-cli-'))
    const file = initializePilotDecisionStore('withdraw-cli', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: Date.now() + 60_000 })
    const requestPath = join(dirname(file), 'requests', `${Buffer.from('r').toString('hex')}.json`)
    const result = spawnSync(process.execPath, ['--import', WITHDRAW, CLI, 'decide', '--run', 'withdraw-cli', '--request', 'r', '--dod', '1', '--reading', 'answer', '--state-root', root], {
      encoding: 'utf8', env: { ...process.env, WT_DECISION_WITHDRAW_REQUEST: requestPath },
    })
    expect(result.status).not.toBe(0)
    expect(result.stderr).toContain('request withdrawn after your decision was recorded')
    expect(result.stdout).not.toContain('decided run=')
  })
  it('rejects invalid and mismatched request ids', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-invalid-'))
    const file = initializePilotDecisionStore('invalid', { root })
    expect(() => registerPilotDecisionRequest(file, { requestId: '\ud800', criteria: [1], deadline: 100 })).toThrow('invalid pilot request id')
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: 100 })
    expect(() => decidePilotRun({ runId: 'invalid', requestId: '../r', criterion: 1, reading: 'answer', root, decidedAt: 1 })).toThrow('invalid pilot request id')
    expect(() => decidePilotRun({ runId: 'invalid', requestId: 'other', criterion: 1, reading: 'answer', root, decidedAt: 1 })).toThrow('no open decision request')
  })

  it('preserves both decisions from simultaneous CLI processes', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-pilot-concurrent-'))
    const file = initializePilotDecisionStore('concurrent', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1, 2], deadline: Date.now() + 60_000 })
    const run = (number: number) => new Promise<number | null>((resolve) => {
      const child = spawn(process.execPath, [CLI, 'decide', '--run', 'concurrent', '--request', 'r', '--dod', String(number), '--reading', `answer ${number}`, '--state-root', root])
      child.on('exit', resolve)
    })
    expect(await Promise.all([run(1), run(2)])).toEqual([0, 0])
    expect(readPilotDecisions(file).map((entry: { criterion: number }) => entry.criterion).sort()).toEqual([1, 2])
  })

  it('claims one winner across 16 parent processes and a fallback, fifty times', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-claim-race-'))
    for (let iteration = 0; iteration < (process.env.WT_DECISION_MUTANT ? 1 : 50); iteration++) {
      const runId = `race-${iteration}`
      const file = initializePilotDecisionStore(runId, { root })
      registerPilotDecisionRequest(file, { requestId: runId, criteria: [1], deadline: Date.now() + 120_000 })
      const gate = join(root, `start-${iteration}`)
      const children = Array.from({ length: 17 }, (_, index) => {
        const label = String(index)
        const child = spawn(process.execPath, [PROCESS, file, root, runId, index === 16 ? 'fallback' : 'parent', gate, label, process.env.WT_DECISION_MUTANT || ''])
        return new Promise<{ source: string, winner?: string, loser?: boolean }>((resolve, reject) => {
          let output = ''
          child.stdout.on('data', (chunk) => { output += chunk })
          child.on('error', reject)
          child.on('exit', (code) => code === 0 ? resolve(JSON.parse(output)) : reject(new Error(`child ${index} exited ${code}: ${output}`)))
        })
      })
      while (Array.from({ length: 17 }, (_, index) => existsSync(`${gate}.${index}.ready`)).some((ready) => !ready)) await new Promise((resolve) => setTimeout(resolve, 5))
      writeFileSync(gate, '')
      const results = await Promise.all(children)
      const winners = results.filter((result) => !result.loser)
      expect(winners, `iteration ${iteration}`).toHaveLength(1)
      const winner = winners[0]!
      expect(results.every((result) => result.source === winner.source), `iteration ${iteration}`).toBe(true)
      expect(fs.readdirSync(join(dirname(file), 'bindings')).filter((name) => name.endsWith('.json'))).toHaveLength(1)
      expect(readPilotDecisions(file).length).toBe(winner.source === 'parent' ? 1 : 0)
      if (winner.source === 'parent') expect(readPilotDecisions(file)[0].reading).toBe(winner.winner)
    }
  }, 300_000)

  it('a crashed publisher leaves only an orphan temp, never a binding to wait on', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-crash-'))
    const file = initializePilotDecisionStore('crash', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: Date.now() + 60_000 })
    const ready = join(root, 'ready')
    const child = spawn(process.execPath, [PROCESS, file, root, 'crash', 'ready', ready])
    while (!existsSync(ready)) await new Promise((resolve) => setTimeout(resolve, 5))
    child.kill('SIGKILL')
    await new Promise((resolve) => child.on('exit', resolve))
    const start = Date.now()
    decidePilotRun({ runId: 'crash', requestId: 'r', criterion: 1, reading: 'survivor', root })
    expect(Date.now() - start).toBeLessThan(500)
    expect(readPilotDecisions(file)[0].reading).toBe('survivor')
  }, 10_000)
  it('returns the previously recorded binding rather than overwriting it', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-winner-'))
    const file = initializePilotDecisionStore('winner', { root })
    registerPilotDecisionRequest(file, { requestId: 'r', criteria: [1], deadline: 100 })
    decidePilotRun({ runId: 'winner', requestId: 'r', criterion: 1, reading: 'parent', root, now: () => 100 })
    expect(bindPilotDecision(file, { requestId: 'r', criterion: 1, source: 'fallback', at: 101 })).toMatchObject({ source: 'parent', reading: 'parent' })
  })
})
