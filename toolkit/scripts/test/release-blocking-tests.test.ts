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
    }, () => true)

    expect(exitCode).toBe(1)
    expect(modes).toEqual(['blocking', 'quarantine'])
  })

  it('refuses a quarantine entry without a card id', () => {
    expect(() => validateQuarantinedTests([
      { ...quarantinedTests[0], cardId: '' },
    ])).toThrow('card id')
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
