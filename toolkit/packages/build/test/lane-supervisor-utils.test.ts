import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
// @ts-expect-error runtime .mjs helper under plugin/bin/lib/
import { argvSummary, laneHardBoundAt, readCurrentSupervision, readLogTail, shellQuote, supervisionPaths, terminalExit, writeJsonAtomic } from '../../../../plugin/bin/lib/lane-supervisor-core.mjs'

const roots: string[] = []
const tempRoot = () => { const root = mkdtempSync(join(tmpdir(), 'wt-supervisor-utils-')); roots.push(root); return root }

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('lane supervisor utilities', () => {
  it('quotes shell values, including embedded single quotes', () => {
    expect(shellQuote('two words')).toBe("'two words'")
    expect(shellQuote("it's a test")).toBe("'it'\"'\"'s a test'")
  })

  it('reads complete and byte-bounded log tails and tolerates missing files', () => {
    const root = tempRoot()
    const log = join(root, 'lane.log')
    writeFileSync(log, '0123456789')

    expect(readLogTail(log, 20)).toBe('0123456789')
    expect(readLogTail(log, 4)).toBe('6789')
    expect(readLogTail(join(root, 'missing.log'))).toBe('')
  })

  it('accepts an exit marker only at the end of the log', () => {
    const root = tempRoot()
    const log = join(root, 'lane.log')
    writeFileSync(log, 'work complete\nEXIT=finished\n')
    expect(terminalExit(log)).toBe('finished')

    writeFileSync(log, 'EXIT=1\ncleanup continued\n')
    expect(terminalExit(log)).toBeNull()
    writeFileSync(log, 'work complete\n')
    expect(terminalExit(log)).toBeNull()
  })

  it('writes indented JSON atomically into a new parent directory', () => {
    const root = tempRoot()
    const file = join(root, 'nested', 'state.json')
    const value = { version: 1, runId: '10-20' }

    writeJsonAtomic(file, value)

    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(value)
    expect(readFileSync(file, 'utf8')).toBe(`${JSON.stringify(value, null, 2)}\n`)
  })

  it('builds supervision paths with and without a run id', () => {
    const root = join(tmpdir(), 'lane root')
    const withoutRun = supervisionPaths(root)
    expect(withoutRun).toEqual({
      dir: join(root, '.lane', 'supervision'),
      pointer: join(root, '.lane', 'supervision', 'current.json'),
      record: null,
      decision: null,
    })
    expect(supervisionPaths(root, '10-20')).toEqual({
      ...withoutRun,
      record: join(root, '.lane', 'supervision', '10-20.json'),
      decision: join(root, '.lane', 'supervision', '10-20.decision.json'),
    })
  })

  it('reads only a valid current supervision record', () => {
    const root = tempRoot()
    const paths = supervisionPaths(root, '10-20')
    expect(readCurrentSupervision(root)).toBeNull()

    writeJsonAtomic(paths.pointer, { version: 1, runId: 'invalid' })
    expect(readCurrentSupervision(root)).toBeNull()
    writeJsonAtomic(paths.pointer, { version: 1, runId: '10-20' })
    expect(readCurrentSupervision(root)).toBeNull()

    const record = { runId: '10-20', state: 'running' }
    writeJsonAtomic(paths.record, record)
    expect(readCurrentSupervision(root)).toEqual(record)
  })

  it('requires finite deadline inputs and computes the full hard bound', () => {
    const complete = {
      timeoutAt: '2026-09-18T12:00:00.000Z',
      timeoutSeconds: 10,
      decisionGraceSeconds: 2,
      maxExtensions: 3,
      extensionCount: 1,
      decisionTransitionBoundMs: 500,
    }
    for (const field of ['timeoutAt', 'timeoutSeconds', 'decisionGraceSeconds', 'maxExtensions']) {
      expect(laneHardBoundAt({ ...complete, [field]: undefined })).toBeNull()
    }
    expect(laneHardBoundAt(complete)).toBe(Date.parse(complete.timeoutAt) + 26_500)
    expect(laneHardBoundAt({ ...complete, extensionCount: 4, decisionTransitionBoundMs: -1 })).toBe(Date.parse(complete.timeoutAt) + 2_000)
  })

  it('summarizes at most eight basenames and 300 characters', () => {
    const argv = Array.from({ length: 9 }, (_, index) => `/long/prefix/${String(index).repeat(50)}`)
    const expected = argv.map((part) => part.split('/').at(-1)).slice(0, 8).join(' ').slice(0, 300)
    expect(argvSummary(argv)).toBe(expected)
    expect(argvSummary(argv)).toHaveLength(300)
    expect(argvSummary(argv)).not.toContain('8'.repeat(50))
  })

})
