import { describe, expect, it } from 'vitest'
import {
  blockingTestPattern,
  quarantinedTests,
  quarantineTestPattern,
  validateQuarantinedTests,
} from '../quarantined-tests.mjs'
import { quarantineNotice, releaseBlockingExitCode, runReleaseBlockingTests } from '../release-blocking-tests.mjs'

describe('release-blocking test quarantine', () => {
  it('does not let a quarantined failure fail the blocking run', () => {
    expect(releaseBlockingExitCode(0, 1)).toBe(0)
  })

  it('still lets a non-quarantined failure fail the blocking run', () => {
    expect(releaseBlockingExitCode(1, 0)).toBe(1)
  })

  it('runs quarantine reporting even when the blocking run fails', () => {
    const modes: string[] = []
    const exitCode = runReleaseBlockingTests((_command, _args, options) => {
      const mode = options.env?.WT_TEST_MODE as string
      modes.push(mode)
      return { status: mode === 'blocking' ? 1 : 0 } as ReturnType<typeof import('node:child_process').spawnSync>
    }, () => true, [{ file: 'scripts/test/wt-wake-channel.test.ts', name: 'answers the MCP handshake and requests while an empty spool emits no channel notification', cardId: '1863398344542389302', waitingOn: 'fixture entry for this lock' }])

    expect(exitCode).toBe(1)
    expect(modes).toEqual(['blocking', 'quarantine'])
  })

  it('refuses a quarantine entry without a card id', () => {
    expect(() => validateQuarantinedTests([
      { file: 'scripts/test/wt-wake-channel.test.ts', name: 'answers the MCP handshake', cardId: '', waitingOn: 'x' },
    ])).toThrow('card id')
  })

  // An empty quarantine is the state the list exists to reach. An alternation of zero names is the
  // empty pattern, which matches EVERY test name: the blocking run would then exclude the whole
  // process-spawning project and still exit green.
  it('keeps every test blocking and quarantines nothing when the list is empty', () => {
    expect(blockingTestPattern([]).test('journals a stalled episode again after it clears and recurs for the same runId')).toBe(true)
    expect(quarantineTestPattern([]).test('journals a stalled episode again after it clears and recurs for the same runId')).toBe(false)
    expect(quarantineNotice([])).toBe('QUARANTINE: 0 tests run separately and do not block release.')
  })

  it('skips the quarantine run when nothing is quarantined, and still returns the blocking status', () => {
    const modes: string[] = []
    const written: string[] = []
    const exitCode = runReleaseBlockingTests((_command, _args, options) => {
      modes.push(options.env?.WT_TEST_MODE as string)
      return { status: 0 } as ReturnType<typeof import('node:child_process').spawnSync>
    }, (text) => { written.push(text); return true }, [])

    expect(exitCode).toBe(0)
    expect(modes).toEqual(['blocking'])
    expect(written.join('')).toContain('QUARANTINE: 0 tests')
  })

  it('keeps every configured quarantine entry grounded in its source and visible in one notice', () => {
    expect(() => validateQuarantinedTests()).not.toThrow()
    const notice = quarantineNotice()
    expect(notice).toContain(`QUARANTINE: ${quarantinedTests.length} tests`)
    for (const entry of quarantinedTests) {
      expect(notice).toContain(entry.file)
      expect(notice).toContain(entry.name)
      expect(notice).toContain(`[card ${entry.cardId}]`)
      expect(notice).toContain(entry.waitingOn)
      expect(quarantineTestPattern().test(entry.name)).toBe(true)
      expect(blockingTestPattern().test(entry.name)).toBe(false)
    }
    expect(blockingTestPattern().exec('an ordinary release-blocking test')?.[0]).toBe('an ordinary release-blocking test')
  })
})
