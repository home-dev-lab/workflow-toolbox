// guard-journal-test-isolation.test.ts — locks the fix for card 1836526445-journal-testpollution:
// a `pnpm test` run must never write into the operator's real, durable guard journal
// (~/.local/state/wt-guard-journal by default). Measured before this fix: a full run added 670
// junk records there in bursts of 64, one burst per run — the 17 test files spawning a real
// guard-hook process without redirecting WT_GUARD_JOURNAL_DIR each inherited the real location
// by omission, not by choice.
//
// This test proves the MECHANISM (the vitest-level default redirect from
// test-support/guard-journal-isolation.setup.ts is actually active for every worker), which is
// the thing that makes the 17 existing call sites safe without editing any of them. The
// COMPLEMENTARY, coarser check — did the real directory change at all, across the whole run —
// lives in test-support/guard-journal-isolation.global-setup.ts and is not duplicated here: this
// file answers "is the redirect wired", that file answers "did anything leak regardless".
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs'
import os from 'node:os'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
// A representative one of the 17 previously-unguarded call sites — this guard is WARN-only, so
// a single crafted command is enough to make it write a journal entry.
const HOOK = join(REPO_ROOT, 'plugin/bin/wt-find-newermt-format-guard-hook.mjs')

function realDefaultJournalDir(): string {
  // Mirrors guard-journal.mjs's own baseDir() fallback exactly, MINUS the env override — this is
  // deliberately the path a guard hook would use if NOTHING redirected it.
  return join(os.homedir(), '.local', 'state', 'wt-guard-journal')
}

function readAllEntries(dir: string): Array<Record<string, unknown>> {
  if (!existsSync(dir)) return []
  const out: Array<Record<string, unknown>> = []
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.ndjson')) continue
    for (const line of readFileSync(join(dir, f), 'utf8').split('\n')) {
      if (line.trim()) out.push(JSON.parse(line))
    }
  }
  return out
}

describe('guard-journal test-suite isolation', () => {
  it('RED->GREEN: WT_GUARD_JOURNAL_DIR is set to a redirect for every test worker by default', () => {
    // Before the fix this env var is simply undefined during a normal `pnpm test` run — nothing
    // in the harness ever set it — so a spawned hook falls through to os.homedir() and writes to
    // the operator's real journal. After the fix, test-support/guard-journal-isolation.setup.ts
    // (wired via vitest.config.mts's `setupFiles`) sets it before any test in this file runs.
    expect(process.env.WT_GUARD_JOURNAL_DIR).toBeTruthy()
    // And it must NOT itself resolve to the real default location — a redirect that happens to
    // equal the thing it's supposed to redirect away from protects nothing.
    expect(process.env.WT_GUARD_JOURNAL_DIR).not.toBe(realDefaultJournalDir())
  })

  it('a guard hook spawned with NO explicit env override lands in the redirected dir, never the real default', () => {
    const redirectDir = process.env.WT_GUARD_JOURNAL_DIR!
    // Snapshot the real default location's entry COUNT before — read-only, never created or
    // written by this test. If it doesn't exist yet, "before" is simply an empty read, and the
    // assertion below distinguishes that from a run that actually added something.
    const beforeCount = readAllEntries(realDefaultJournalDir()).length

    // The exact previously-broken pattern: no `env` key at all, so Node's spawnSync inherits
    // `process.env` as-is — precisely how all 17 unguarded call sites invoke their hook.
    const res = spawnSync(process.execPath, [HOOK], {
      input: JSON.stringify({
        hook_event_name: 'PreToolUse',
        tool_name: 'Bash',
        tool_input: { command: 'find . -newermt "5 minutes ago"' },
      }),
      encoding: 'utf8',
    })
    expect(res.status).toBe(0)
    // Sanity: the hook actually decided to warn (otherwise this test would trivially pass by
    // never producing a record at all — see this file's own header on avoiding exactly that).
    expect(res.stdout).toContain('hookSpecificOutput')

    const redirectedEntries = readAllEntries(redirectDir)
    expect(redirectedEntries.some((e) => e.guard === 'wt-find-newermt-format-guard-hook.mjs')).toBe(true)

    const afterCount = readAllEntries(realDefaultJournalDir()).length
    expect(afterCount).toBe(beforeCount) // the real location is untouched — the discriminating assertion
  })

  it('CONTROL: an explicit WT_GUARD_JOURNAL_DIR override still wins over the suite default', () => {
    const ownDir = mkdtempSync(join(tmpdir(), 'wt-guard-journal-isolation-control-'))
    // Count-delta, not content-match: another test in this same file legitimately writes the
    // identical "5 minutes ago" reason into the suite-default redirect dir, so a text match here
    // would be a false positive regardless of which directory this call actually wrote to.
    const beforeRedirectCount = readAllEntries(process.env.WT_GUARD_JOURNAL_DIR!).length
    try {
      const res = spawnSync(process.execPath, [HOOK], {
        input: JSON.stringify({
          hook_event_name: 'PreToolUse',
          tool_name: 'Bash',
          tool_input: { command: 'find . -newermt "5 minutes ago"' },
        }),
        encoding: 'utf8',
        env: { ...process.env, WT_GUARD_JOURNAL_DIR: ownDir },
      })
      expect(res.status).toBe(0)
      expect(readAllEntries(ownDir).length).toBe(1)
      // And the suite-wide redirect dir gained NOTHING from this call — the override, not the
      // default, decided where it landed.
      const afterRedirectCount = readAllEntries(process.env.WT_GUARD_JOURNAL_DIR!).length
      expect(afterRedirectCount).toBe(beforeRedirectCount)
    } finally {
      rmSync(ownDir, { recursive: true, force: true })
    }
  })
})
