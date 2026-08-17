// guard-journal-global-setup.test.ts — locks the fix for card 1843667432-journal-soletest: the
// mechanical journal-pollution backstop in test-support/guard-journal-isolation.global-setup.ts
// must throw only when this run can reasonably believe it is the journal's sole writer (CI, or
// the opt-in WT_GUARD_JOURNAL_ISOLATION_STRICT), and must warn-without-failing otherwise — because
// the watched directory (~/.local/state/wt-guard-journal by default) is MACHINE-GLOBAL, not
// per-run, and a `pnpm test` exit code must not depend on what another session on the same
// machine writes there while this run is in flight.
//
// This test never touches the real machine-global journal: every case redirects
// WT_GUARD_JOURNAL_DIR to a fresh temp directory before calling setup(), exactly the override the
// module itself reads in realJournalDir().
//
// Four cases, all exercising the SAME exported setup()/teardown() pair the real vitest globalSetup
// hook uses — this is a direct import, not a subprocess, so a future edit that reintroduces "throw
// unconditionally" or "never throw" breaks one of these deterministically instead of only showing
// up as a machine-dependent flake in someone's local run.
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import setup from '../../../test-support/guard-journal-isolation.global-setup'

const ENV_KEYS = ['CI', 'WT_GUARD_JOURNAL_DIR', 'WT_GUARD_JOURNAL_ISOLATION_STRICT'] as const

let savedEnv: Record<string, string | undefined>
let tempDirs: string[]

beforeEach(() => {
  savedEnv = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]))
  tempDirs = []
})

afterEach(() => {
  // Restore exactly what was there before — leaking CI or the strict var into a sibling test
  // would make other files' results depend on execution order, the same class of bug this file
  // exists to lock shut for the journal directory itself.
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k]
    else process.env[k] = savedEnv[k]
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

function freshJournalDir(): string {
  const dir = mkdtempSync(join(os.tmpdir(), 'wt-guard-journal-global-setup-test-'))
  tempDirs.push(dir)
  process.env.WT_GUARD_JOURNAL_DIR = dir
  return dir
}

function simulateGrowth(dir: string): void {
  writeFileSync(join(dir, 'leak.ndjson'), '{"guard":"fake"}\n')
}

describe('guard-journal-isolation.global-setup: sole-writer-conditional throw', () => {
  it('CI truthy + journal growth: teardown throws', () => {
    delete process.env.WT_GUARD_JOURNAL_ISOLATION_STRICT
    process.env.CI = 'true'
    const dir = freshJournalDir()
    const teardown = setup()
    simulateGrowth(dir)
    expect(() => teardown()).toThrow(/GUARD JOURNAL CHANGED/)
  })

  it('WT_GUARD_JOURNAL_ISOLATION_STRICT truthy + journal growth: teardown throws', () => {
    delete process.env.CI
    process.env.WT_GUARD_JOURNAL_ISOLATION_STRICT = '1'
    const dir = freshJournalDir()
    const teardown = setup()
    simulateGrowth(dir)
    expect(() => teardown()).toThrow(/GUARD JOURNAL CHANGED/)
  })

  it('neither signal set + journal growth: teardown does NOT throw, and warns', () => {
    delete process.env.CI
    delete process.env.WT_GUARD_JOURNAL_ISOLATION_STRICT
    const dir = freshJournalDir()
    const teardown = setup()
    simulateGrowth(dir)
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => teardown()).not.toThrow()
    expect(warnSpy).toHaveBeenCalledTimes(1)
    expect(warnSpy.mock.calls[0]?.[0]).toMatch(/GUARD JOURNAL CHANGED/)
  })

  it('no growth at all: teardown neither throws nor warns, in either sole-writer mode', () => {
    // Guards against a mutation that makes the throw/warn unconditional — a check firing on every
    // CLEAN run is exactly as broken as one that never fires on a dirty one, and case-by-case
    // assertions above wouldn't catch it: they only look at what happens WHEN there is growth.
    delete process.env.CI
    delete process.env.WT_GUARD_JOURNAL_ISOLATION_STRICT
    const dirWarnMode = freshJournalDir()
    const teardownWarnMode = setup()
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    expect(() => teardownWarnMode()).not.toThrow()
    expect(warnSpy).not.toHaveBeenCalled()
    void dirWarnMode

    process.env.CI = 'true'
    const dirStrictMode = freshJournalDir()
    const teardownStrictMode = setup()
    expect(() => teardownStrictMode()).not.toThrow()
    void dirStrictMode
  })
})
