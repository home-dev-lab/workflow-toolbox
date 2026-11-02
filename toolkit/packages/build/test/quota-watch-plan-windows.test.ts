// quota-watch-plan-windows.test.ts — each quota window is watched on its own.
//
// WHAT THIS PROTECTS: the watcher used to judge a reading WHOLE: one window without a usable
// percentage made the whole reading DEGRADED, so it watched NOTHING, the seven-day window included.
// On a plan with no five-hour limit the probes this machine uses never state that absence (the
// rate-limit headers omit the window, and the host documents omission as also meaning "reset
// passed"), so the watcher stayed blind for good (card 1899394115301279304, round 3).
//
// The contract now: every window with a numeric `pct` is watched; a window without one (omitted,
// `null`, or an object without a numeric pct) is said ONCE per run, in words, to be not reported by
// the probe, and its crossing and reset history is kept, never cleared as if the window were gone.
// Only a reading with no numeric window at all is DEGRADED.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const WATCH = join(REPO_ROOT, 'plugin/bin/wt-quota-watch.mjs')
const TOKEN = 'token-abc123abc123'
const FUTURE = new Date(Date.now() + 3 * 86_400_000).toISOString()
const PAST = new Date(Date.now() - 60_000).toISOString()
const LOST_WINDOW = { pct: null, pctRaw: null, resets_at: null }
const CONTRADICTED = { pct: null, pctRaw: 94, resets_at: null }
const FIVE_HOUR_NOT_REPORTED = 'QUOTA WATCH: the 5-hour window is not reported by the probe'
const SEVEN_DAY_NOT_REPORTED = 'QUOTA WATCH: the 7-day window is not reported by the probe'

const roots: string[] = []
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

const win = (pct: number, resetsAt = FUTURE) => ({ pct, resets_at: resetsAt, reset_local: 'Fri 06/11 04:00' })

interface RunOptions { cycles?: number, accountKey?: string | null, fingerprint?: boolean }

/** Probe printing payloads[n] on its n-th call (the last one repeats), in an isolated config dir. */
function runSequence(payloads: Array<Record<string, unknown>>, options: RunOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), 'wt-quota-plan-'))
  roots.push(root)
  const counter = join(root, 'counter')
  const probe = join(root, 'probe.mjs')
  const accountKey = options.accountKey === undefined ? TOKEN : options.accountKey
  const identity = accountKey === null ? {} : { accountKey }
  writeFileSync(probe, `import { readFileSync, writeFileSync } from 'node:fs';
let n = 0; try { n = Number(readFileSync(${JSON.stringify(counter)}, 'utf8')) } catch {}
writeFileSync(${JSON.stringify(counter)}, String(n + 1));
const all = ${JSON.stringify(payloads)};
console.log(JSON.stringify({ configDir: process.env.CLAUDE_CONFIG_DIR, ...${JSON.stringify(identity)}, ...all[Math.min(n, all.length - 1)] }));\n`)
  if (options.fingerprint) writeFileSync(join(root, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-fixture' } }))
  const res = spawnSync(process.execPath, [WATCH, '--probe', probe, '--poll', '5', '--timeout', '3'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
      ...process.env,
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_AUTH_TOKEN: '',
      WT_SESSION_ROLE: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CONFIG_DIR: root,
      WT_QUOTA_WATCH_TEST_SLEEP_LOG: join(root, 'sleeps'),
      WT_QUOTA_WATCH_TEST_MAX_CYCLES: String(options.cycles ?? payloads.length),
    },
  })
  const count = existsSync(counter) ? Number(readFileSync(counter, 'utf8')) : 0
  const sleeps = existsSync(join(root, 'sleeps')) ? readFileSync(join(root, 'sleeps'), 'utf8').trim().split('\n').filter(Boolean).map(Number) : []
  return { stdout: res.stdout, status: res.status, count, root, sleeps }
}

const armedLine = (stdout: string) => stdout.split('\n').find((line) => line.startsWith('QUOTA WATCH ARMED')) ?? ''
const countOf = (stdout: string, needle: string) => stdout.split('\n').filter((line) => line.includes(needle)).length

// The three shapes a window without a numeric percentage takes; none of them is absence.
const UNREPORTED_SHAPES: Array<[string, unknown]> = [
  ['omitted', undefined],
  ['null', null],
  ['an object without a numeric pct', LOST_WINDOW],
]
const withFiveHour = (shape: unknown, rest: Record<string, unknown>) => (shape === undefined ? rest : { five_hour: shape, ...rest })

describe('point 1: a window without a reading never blinds the other one', () => {
  for (const [name, shape] of UNREPORTED_SHAPES) {
    it(`five_hour ${name}: the seven-day window is watched and its crossing reported`, () => {
      const res = runSequence([withFiveHour(shape, { seven_day: win(70) }), withFiveHour(shape, { seven_day: win(91) })])
      expect(res.stdout).toContain('QUOTA 7d: 91% — crossed the 90% threshold')
      expect(res.stdout).not.toContain('DEGRADED')
    })
  }

  it('seven_day missing: the five-hour window is watched and its crossing reported', () => {
    const res = runSequence([{ five_hour: win(70) }, { five_hour: win(85) }])
    expect(res.stdout).toContain('QUOTA 5h: 85% — crossed the 80% threshold')
    expect(res.stdout).toContain(SEVEN_DAY_NOT_REPORTED)
    expect(res.stdout).not.toContain('DEGRADED')
  })

  it('a seven-day RESET is reported while five_hour is not reported', () => {
    const res = runSequence([
      { five_hour: LOST_WINDOW, seven_day: win(85, PAST) },
      { five_hour: LOST_WINDOW, seven_day: win(4) },
    ], { fingerprint: true })
    expect(res.stdout).toMatch(/^QUOTA RESET 7d: 4% \(was 85%\)/m)
    expect(res.stdout).not.toContain('DEGRADED')
  })

  it('a partial reading is served from the shared login cache on the next poll (one live call for two cycles)', () => {
    const res = runSequence([{ five_hour: LOST_WINDOW, seven_day: win(40) }], { accountKey: null, cycles: 2 })
    const cache = JSON.parse(readFileSync(join(res.root, '.quota-cache.json'), 'utf8'))
    expect(cache.data.seven_day.pct).toBe(40)
    expect(res.count).toBe(1)
    expect(res.stdout).not.toContain('DEGRADED')
  })
})

describe('point 2: a window without a reading is reported once, in words, and keeps its history', () => {
  for (const [name, shape] of UNREPORTED_SHAPES) {
    it(`five_hour ${name}: said ONCE per run to be not reported by the probe, never "absent"`, () => {
      const res = runSequence([
        withFiveHour(shape, { seven_day: win(70) }),
        withFiveHour(shape, { seven_day: win(71) }),
        withFiveHour(shape, { seven_day: win(72) }),
      ])
      expect(countOf(res.stdout, FIVE_HOUR_NOT_REPORTED)).toBe(1)
      expect(res.stdout).not.toMatch(/absent|part of this plan/)
    })
  }

  // Astra's sequence (cross-family review, 2026-11-02): a window treated as gone lost its state,
  // then the returning 94 % was baselined as "already crossed" and the 80/90 % alerts never fired.
  for (const [name, shape] of [...UNREPORTED_SHAPES, ['an object with a contradicting pctRaw', CONTRADICTED]] as Array<[string, unknown]>) {
    it(`70 -> five_hour ${name} -> 94 -> 94 still emits the 80 and 90 crossings`, () => {
      const res = runSequence([
        { five_hour: win(70), seven_day: win(40) },
        withFiveHour(shape, { seven_day: win(40) }),
        { five_hour: win(94), seven_day: win(40) },
        { five_hour: win(94), seven_day: win(40) },
      ])
      expect(res.stdout).toContain('QUOTA 5h: 94% — crossed the 80% threshold')
      expect(res.stdout).toContain('QUOTA 5h: 94% — crossed the 90% threshold')
      expect(countOf(res.stdout, FIVE_HOUR_NOT_REPORTED)).toBe(1)
      expect(res.stdout).not.toContain('DEGRADED')
    })
  }

  it('85 (reset time passed) -> unreported -> 4 still reports the reset', () => {
    const res = runSequence([
      { five_hour: win(85, PAST), seven_day: win(40) },
      { five_hour: LOST_WINDOW, seven_day: win(40) },
      { five_hour: win(4), seven_day: win(40) },
    ], { fingerprint: true })
    expect(res.stdout).toMatch(/^QUOTA RESET 5h: 4% \(was 85%\)/m)
  })
})

describe('point 3: a reading with no numeric window at all stays DEGRADED', () => {
  const cases: Array<[string, Record<string, unknown>]> = [
    ['both windows omitted', {}],
    ['both windows null', { five_hour: null, seven_day: null }],
    ['both windows empty objects', { five_hour: LOST_WINDOW, seven_day: LOST_WINDOW }],
    ['malformed windows', { five_hour: { pct: 'high' }, seven_day: 'none' }],
  ]
  for (const [name, payload] of cases) {
    it(`degrades, never arms a reading, and backs off when ${name}`, () => {
      const res = runSequence([payload], { cycles: 2 })
      expect(res.stdout).toContain('QUOTA WATCH DEGRADED: probe output INVALID (missing window(s): five_hour,seven_day) (reported once)')
      expect(armedLine(res.stdout)).not.toContain('watching')
      expect(res.stdout).not.toContain('not reported by the probe')
      expect(res.count).toBe(2)
      expect(res.sleeps).toEqual([10_000, 20_000])
    })
  }

  it('after arming, a reading with no numeric window degrades and leaves every history intact', () => {
    const res = runSequence([
      { five_hour: win(70), seven_day: win(40) },
      { five_hour: null, seven_day: null },
      { five_hour: win(94), seven_day: win(40) },
    ])
    expect(res.stdout).toContain('QUOTA WATCH DEGRADED: probe output INVALID (missing window(s): five_hour,seven_day)')
    expect(res.stdout).toContain('QUOTA 5h: 94% — crossed the 90% threshold')
  })
})

describe('point 4: the armed line names the watched windows; a window that turns numeric is watched from then on', () => {
  it('names both windows when both are reported', () => {
    const res = runSequence([{ five_hour: win(10), seven_day: win(20) }], { cycles: 1 })
    expect(armedLine(res.stdout)).toMatch(/^QUOTA WATCH ARMED: thresholds=.* \| watching 5h,7d$/)
    expect(res.stdout).not.toContain('not reported by the probe')
  })

  it('names only the seven-day window when five_hour is not reported, then says why on its own line', () => {
    const res = runSequence([{ five_hour: LOST_WINDOW, seven_day: win(20) }], { cycles: 1 })
    expect(armedLine(res.stdout)).toMatch(/ \| watching 7d$/)
    expect(res.stdout).toContain(`${FIVE_HOUR_NOT_REPORTED} — not watched until it is; watching 7d (reported once)`)
  })

  it('a five-hour window reported later is baselined then watched, without a restart', () => {
    const res = runSequence([
      { five_hour: LOST_WINDOW, seven_day: win(40) },
      { five_hour: win(85), seven_day: win(40) },
      { five_hour: win(92), seven_day: win(40) },
    ])
    expect(res.stdout).toMatch(/^QUOTA WATCH: the 5-hour window is now reported by the probe — watching 5h,7d \| 5h 85% \(thresholds already crossed: 80%\)/m)
    expect(res.stdout).not.toContain('QUOTA 5h: 85% — crossed')
    expect(res.stdout).toContain('QUOTA 5h: 92% — crossed the 90% threshold')
  })

  it('an account change forgets the history of a window the new reading does not carry', () => {
    const res = runSequence([
      { accountKey: 'account-a', five_hour: win(70), seven_day: win(40) },
      { accountKey: 'account-b', five_hour: LOST_WINDOW, seven_day: win(10) },
      { accountKey: 'account-b', five_hour: win(20), seven_day: win(10) },
    ])
    expect(res.stdout).toContain('QUOTA ACCOUNT CHANGED')
    expect(res.stdout).toMatch(/^QUOTA WATCH: the 5-hour window is now reported by the probe/m)
    expect(res.stdout).not.toMatch(/QUOTA (DROP|RESET) 5h/)
  })
})

/** Live baseline from `live`, then a login-cache reading seeded before the second cycle (which reads the cache first). */
async function runWithSeededCache(live: Record<string, unknown>, seed: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'wt-quota-plan-cache-'))
  roots.push(root)
  const counter = join(root, 'counter')
  const probe = join(root, 'probe.mjs')
  const sleeps = join(root, 'sleeps')
  const barrier = join(root, 'barrier')
  writeFileSync(probe, `import { readFileSync, writeFileSync } from 'node:fs';
let n = 0; try { n = Number(readFileSync(${JSON.stringify(counter)}, 'utf8')) } catch {}
writeFileSync(${JSON.stringify(counter)}, String(n + 1));
console.log(JSON.stringify({ configDir: process.env.CLAUDE_CONFIG_DIR, accountKey: 'login', ...${JSON.stringify(live)} }));\n`)
  writeFileSync(sleeps, '')
  const child = spawn(process.execPath, [WATCH, '--probe', probe, '--poll', '5', '--timeout', '3'], { env: { ...process.env, ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', WT_SESSION_ROLE: '', CLAUDE_CODE_OAUTH_TOKEN: '', CLAUDE_CONFIG_DIR: root, WT_QUOTA_WATCH_ALLOW_DUPLICATE: '1', WT_QUOTA_WATCH_TEST_SLEEP_LOG: sleeps, WT_QUOTA_WATCH_TEST_SLEEP_BARRIER: barrier, WT_QUOTA_WATCH_TEST_MAX_CYCLES: '2' } })
  let stdout = ''
  child.stdout.on('data', (chunk) => { stdout += chunk })
  const done = new Promise<number | null>((resolve, reject) => { child.on('error', reject); child.on('close', resolve) })
  const watcher = watch(sleeps)
  try {
    await new Promise<void>((resolve, reject) => {
      watcher.on('change', () => { if (readFileSync(sleeps, 'utf8').trim() !== '') resolve() })
      done.then(() => reject(new Error('watcher exited before its sleep barrier')), reject)
    })
    writeFileSync(join(root, '.quota-cache.json'), JSON.stringify({ at: Date.now(), data: { configDir: root, accountKey: 'login', ...seed } }))
    writeFileSync(barrier, '')
    expect(await done).toBe(0)
    return { stdout, count: Number(readFileSync(counter, 'utf8')) }
  } finally { watcher.close(); child.kill('SIGKILL') }
}

describe('point 5: the cache door uses a cached reading only when it carries every window the last reading did', () => {
  const BOTH = { five_hour: win(10), seven_day: win(40) }
  for (const [name, shape] of UNREPORTED_SHAPES) {
    it(`after a two-window reading, a cached five_hour ${name} is not used: the watcher probes live`, async () => {
      const res = await runWithSeededCache(BOTH, withFiveHour(shape, { seven_day: win(40) }))
      expect(res.count).toBe(2)
    })
  }

  it('a cached reading carrying both windows is used (control: the cache door is open)', async () => {
    const res = await runWithSeededCache(BOTH, BOTH)
    expect(res.count).toBe(1)
  })

  it('after a seven-day-only reading, a seven-day-only cached reading is used (no live call per poll)', async () => {
    const res = await runWithSeededCache({ five_hour: LOST_WINDOW, seven_day: win(40) }, { seven_day: win(41) })
    expect(res.count).toBe(1)
    expect(res.stdout).not.toContain('DEGRADED')
  })
})

const BUNDLED_PROBE = join(REPO_ROOT, 'plugin/bin/wt-quota-probe.mjs')

/** The real watcher driving the bundled probe, for a usage endpoint stubbed to answer `body`. */
function watchWithBundledProbe(body: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'wt-quota-plan-bundled-'))
  roots.push(root)
  const stub = join(root, 'fetch-stub.mjs')
  writeFileSync(stub, `globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => (${JSON.stringify(body)}) })\n`)
  return spawnSync(process.execPath, [WATCH, '--probe', BUNDLED_PROBE, '--poll', '5', '--timeout', '3'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(stub).href}`, ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', WT_SESSION_ROLE: '', CLAUDE_CODE_OAUTH_TOKEN: 'stub-session', CLAUDE_CONFIG_DIR: root, WT_QUOTA_WATCH_TEST_SLEEP_LOG: join(root, 'sleeps'), WT_QUOTA_WATCH_TEST_MAX_CYCLES: '1' },
  }).stdout
}

describe('the BUNDLED probe, against a usage endpoint without a five-hour window', () => {
  for (const [name, body] of [['omits five_hour', { seven_day: { utilization: 40 } }], ['states five_hour: null', { five_hour: null, seven_day: { utilization: 40 } }]] as const) {
    it(`an endpoint that ${name} arms on the seven-day window and says five_hour is not reported`, () => {
      const stdout = watchWithBundledProbe(body)
      expect(armedLine(stdout)).toMatch(/ \| watching 7d$/)
      expect(stdout).toContain(FIVE_HOUR_NOT_REPORTED)
      expect(stdout).not.toContain('DEGRADED')
    })
  }
})
