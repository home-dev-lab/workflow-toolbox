// quota-watch-single-instance.test.ts — a project must not end up with two live quota
// watchers, and two DIFFERENT projects must still each get their own.
//
// WHAT THIS PROTECTS, and why it is not an efficiency concern: two watchers share the on-disk
// quota cache, so they add almost no requests. What they double is the NOTIFICATIONS — and a
// channel that reports the same event twice stops being read, which costs precisely the alerts
// the watcher exists to deliver. Measured 2026-08-05: one session held two watchers and every
// window-reset event arrived twice; the duplicate was noticed only because a human said so.
//
// THE LOCK IS THE INVARIANT, NOT AN ENUMERATION. It asserts the property "a second arm in the
// same cwd does not arm" rather than matching a fixed refusal sentence, so rewording the
// message cannot silently turn the lock green on a broken guard.
//
// ⚠ The negative case is the one that matters and the one an enumeration would miss: a guard
// keyed too broadly (on the config dir, say — the quota IS per account, so it is a tempting
// key) would refuse a second PROJECT, leaving that project silently unwatched. That failure
// looks exactly like success from inside the first project, which is why it is locked here.
import { spawnSync } from 'node:child_process'
import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const WATCH = join(REPO_ROOT, 'plugin/bin/wt-quota-watch.mjs')

const roots: string[] = []
function tmpDir(prefix: string): string {
  const d = mkdtempSync(join(tmpdir(), prefix))
  roots.push(d)
  return d
}
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true })
})

/** A probe printing one fixed HEALTHY, VALID payload.
 *
 *  ⚠ The shape matters and an invalid one passes silently for the wrong reason. An earlier
 *  version of this helper emitted `{five_hour: {utilization: 10}}` — a field the watcher does
 *  not read. It went down the "probe output INVALID" path, produced no reading, and these tests
 *  still passed because the arming line was written before any reading existed. The moment
 *  arming was merged into the first reading, four of them failed. The fixture was wrong from the
 *  start; nothing could tell, because the assertion did not depend on the part that was broken. */
function fakeProbe(): string {
  const p = join(tmpDir('wt-qw-probe-'), 'fake-probe.mjs')
  const payload = {
    configDir: '/fake',
    quota_model: 'subscription',
    five_hour: { pct: 12, resets_at: new Date(Date.now() + 3_600_000).toISOString(), reset_local: '11:20', reset_in: '1h00' },
    seven_day: { pct: 30, resets_at: new Date(Date.now() + 86_400_000).toISOString(), reset_local: 'Fri 07/08', reset_in: '1j00h', severity: 'normal' },
    weekly_scoped: [],
  }
  writeFileSync(p, `console.log(${JSON.stringify(JSON.stringify(payload))})\n`)
  chmodSync(p, 0o755)
  return p
}

/** Run the watcher to completion in `cwd`, bounded to one cycle so it exits on its own. */
function arm(configDir: string, cwd: string, probe: string, env: Record<string, string> = {}) {
  return spawnSync(process.execPath, [WATCH, '--probe', probe, '--poll', '5', '--timeout', '3'], {
    encoding: 'utf8',
    timeout: 20_000,
    cwd,
    env: {
      ...process.env,
      CLAUDE_CONFIG_DIR: configDir,
      WT_QUOTA_WATCH_TEST_MAX_CYCLES: '1',
      ...env,
    },
  })
}

/** Seed the registry with an entry for a pid that is CERTAIN to be alive: this test process.
 *  Using our own pid rather than a spawned one removes the race entirely — the guard's liveness
 *  check is exercised for real, against a process that cannot have exited mid-assertion. */
function seedLiveEntry(configDir: string, cwd: string) {
  writeFileSync(
    join(configDir, '.quota-watch-instances.json'),
    JSON.stringify([{ pid: process.pid, cwd, startedAt: new Date().toISOString() }], null, 2),
  )
}

describe('quota watch single-instance guard', () => {
  it('refuses to arm when the SAME project already has a live watcher', () => {
    const configDir = tmpDir('wt-qw-cfg-')
    const project = tmpDir('wt-qw-proj-')
    seedLiveEntry(configDir, project)

    const r = arm(configDir, project, fakeProbe())

    expect(r.stdout).not.toContain('QUOTA WATCH ARMED')
    expect(r.stdout).toContain('NOT ARMED')
    expect(r.status).toBe(0) // nothing failed — the watcher asked for already exists
  })

  it('DOES arm for a DIFFERENT project on the same account', () => {
    const configDir = tmpDir('wt-qw-cfg-')
    const projectA = tmpDir('wt-qw-projA-')
    const projectB = tmpDir('wt-qw-projB-')
    seedLiveEntry(configDir, projectA)

    const r = arm(configDir, projectB, fakeProbe())

    expect(r.stdout).toContain('QUOTA WATCH ARMED')
  })

  it('arms when the recorded pid is DEAD — a stale entry must not lock a project out', () => {
    const configDir = tmpDir('wt-qw-cfg-')
    const project = tmpDir('wt-qw-proj-')
    // A pid that cannot be running: spawn something trivial and let it exit first.
    const dead = spawnSync(process.execPath, ['-e', 'process.exit(0)'])
    const deadPid = (dead.pid ?? 0) || 2 ** 22 // fall back to a pid above the usual max
    writeFileSync(
      join(configDir, '.quota-watch-instances.json'),
      JSON.stringify([{ pid: deadPid, cwd: project, startedAt: '2020-01-01T00:00:00.000Z' }], null, 2),
    )

    const r = arm(configDir, project, fakeProbe())

    expect(r.stdout).toContain('QUOTA WATCH ARMED')
    // …and the stale entry is gone: pruning happens on the same read that decides.
    const after = JSON.parse(readFileSync(join(configDir, '.quota-watch-instances.json'), 'utf8'))
    expect(after.some((e: { pid: number }) => e.pid === deadPid)).toBe(false)
  })

  it('emits arming and the first reading as ONE line, not two notifications', () => {
    // Every stdout line becomes a separate notification for whoever is watching. Two lines a
    // second apart, saying "armed" then "here is the state", read as a DUPLICATE — measured on a
    // real channel 2026-08-05, where it was reported as a suspected bug. The facts belong
    // together; splitting them costs the channel's credibility for no information gained.
    // ⚠ The payload must CROSS a threshold, or there is no initial status to merge and the test
    // would pass vacuously on a watcher that never merged anything. A healthy account emits the
    // arming line alone — correctly, and indistinguishably from a broken merge.
    const configDir = tmpDir('wt-qw-cfg-')
    const project = tmpDir('wt-qw-proj-')
    const p = join(tmpDir('wt-qw-probe-'), 'loaded-probe.mjs')
    writeFileSync(
      p,
      `console.log(${JSON.stringify(
        JSON.stringify({
          configDir: '/fake',
          quota_model: 'subscription',
          five_hour: { pct: 3, resets_at: new Date(Date.now() + 3_600_000).toISOString(), reset_local: '17:10', reset_in: '4h00' },
          seven_day: { pct: 96, resets_at: new Date(Date.now() + 86_400_000).toISOString(), reset_local: 'Fri 07/08', reset_in: '1j00h', severity: 'warning' },
          weekly_scoped: [],
        }),
      )})\n`,
    )
    chmodSync(p, 0o755)

    const r = arm(configDir, project, p)

    const armedLines = r.stdout.split('\n').filter((l) => l.includes('QUOTA WATCH ARMED'))
    const statusLines = r.stdout.split('\n').filter((l) => l.startsWith('QUOTA STATUS:'))
    expect(armedLines).toHaveLength(1)
    expect(statusLines).toHaveLength(0) // the reading rides ON the arming line, not beside it
    expect(armedLines[0]).toContain('7d 96%') // …and it genuinely carries the reading
  })

  it('arms anyway when the duplicate is explicitly allowed', () => {
    const configDir = tmpDir('wt-qw-cfg-')
    const project = tmpDir('wt-qw-proj-')
    seedLiveEntry(configDir, project)

    const r = arm(configDir, project, fakeProbe(), { WT_QUOTA_WATCH_ALLOW_DUPLICATE: '1' })

    expect(r.stdout).toContain('QUOTA WATCH ARMED')
  })

  it('survives a corrupt registry rather than refusing to watch', () => {
    const configDir = tmpDir('wt-qw-cfg-')
    const project = tmpDir('wt-qw-proj-')
    writeFileSync(join(configDir, '.quota-watch-instances.json'), 'not json at all {{{')

    const r = arm(configDir, project, fakeProbe())

    // A guard that dies on its own bookkeeping file is worse than the duplicate it prevents.
    expect(r.stdout).toContain('QUOTA WATCH ARMED')
    expect(existsSync(join(configDir, '.quota-watch-instances.json'))).toBe(true)
  })
})
