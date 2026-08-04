// quota-watch-no-subscription.test.ts — an account with no subscription quota must make the
// watcher SAY SO and stop, never sit there looking armed while watching nothing.
//
// WHAT THIS PROTECTS: usage-billed (pay-per-token) accounts have no five-hour or seven-day
// window at all. Every window then reads as absent — which is the SAME SHAPE as a probe that
// cannot measure. Left alone, the watcher polls forever, emits nothing, and its silence is
// indistinguishable from "quota is fine". That is the inverting-guard failure this repo keeps
// closing: a mechanism that cannot produce the signal saying it is not working.
//
// The discriminator is the probe's explicit `quota_model`, never the absence of a percentage:
// an absent window and an unreadable one are identical from the watcher's side, and only the
// probe can tell them apart.
import { spawnSync } from 'node:child_process'
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const WATCH = join(REPO_ROOT, 'plugin/bin/wt-quota-watch.mjs')

const roots: string[] = []
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A stand-in probe that prints one fixed payload — the only input that decides this branch. */
function fakeProbe(payload: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), 'wt-quota-watch-'))
  roots.push(dir)
  const p = join(dir, 'fake-probe.mjs')
  writeFileSync(p, `console.log(${JSON.stringify(JSON.stringify(payload))})\n`)
  chmodSync(p, 0o755)
  return p
}

function runWatch(probePath: string) {
  return spawnSync(
    process.execPath,
    [WATCH, '--probe', probePath, '--poll', '5', '--timeout', '3'],
    {
      encoding: 'utf8',
      timeout: 20_000,
      // Bound the loop so a REGRESSION (the watcher failing to stop) shows up as a
      // timeout/cycle cap rather than hanging this suite forever.
      env: { ...process.env, WT_QUOTA_WATCH_TEST_MAX_CYCLES: '3', WT_QUOTA_WATCH_TEST_SLEEP_LOG: '' },
    },
  )
}

const USAGE_BILLED = { configDir: '/fake', quota_model: 'none', five_hour: { pct: null, resets_at: null }, seven_day: { pct: null, resets_at: null }, weekly_scoped: [] }
const SUBSCRIPTION = {
  configDir: '/fake',
  quota_model: 'subscription',
  five_hour: { pct: 12, resets_at: new Date(Date.now() + 3_600_000).toISOString(), reset_local: '11:20', reset_in: '1h00' },
  seven_day: { pct: 30, resets_at: new Date(Date.now() + 86_400_000).toISOString(), reset_local: 'Fri 07/08', reset_in: '1j00h', severity: 'normal' },
  weekly_scoped: [],
}

describe('wt-quota-watch on an account with no subscription quota', () => {
  it('says there is nothing to watch, and EXITS — it does not sit there looking armed', () => {
    const res = runWatch(fakeProbe(USAGE_BILLED))
    expect(res.status).toBe(0)
    expect(res.stdout).toContain('QUOTA WATCH STOPPING')
    expect(res.stdout).toContain('no subscription quota')
  })

  it('does not report a percentage for a limit that does not exist', () => {
    const res = runWatch(fakeProbe(USAGE_BILLED))
    // ⚠ This assertion is only meaningful if the watcher actually RAN — an assertion on the
    // ABSENCE of something passes vacuously when nothing was produced at all (measured: it
    // went green while the process had died on an argument error). So pin the positive
    // evidence first, then the absence.
    expect(res.stdout).toContain('QUOTA WATCH STOPPING')
    expect(res.stdout).not.toMatch(/\b0%/)
    expect(res.stdout).not.toContain('null%')
  })

  it('a SUBSCRIPTION account is untouched — it arms and reports as before', () => {
    // The control that makes the two above meaningful: if the watcher stopped for everyone,
    // both would still pass while the feature was destroyed.
    const res = runWatch(fakeProbe(SUBSCRIPTION))
    expect(res.stdout).toContain('QUOTA WATCH ARMED')
    expect(res.stdout).not.toContain('QUOTA WATCH STOPPING')
  })
})
