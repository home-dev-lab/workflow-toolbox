// quota-watch-plan-windows.test.ts — each quota window is watched on its own.
//
// WHAT THIS PROTECTS: the watcher used to judge a reading WHOLE: one window without a usable
// percentage made the whole reading DEGRADED, so it watched NOTHING, the seven-day window included.
// On a plan with no five-hour limit the probes this machine uses never state that absence (the
// rate-limit headers omit the window, and the host documents omission as also meaning "reset
// passed"), so the watcher stayed blind for good.
//
// The contract now: every window with a numeric `pct` is watched; a window without one (omitted,
// `null`, or an object without a numeric pct) is said ONCE per run, in words, to be not reported by
// the probe, and its crossing and reset history is kept, never cleared as if the window were gone.
// Only a reading with no numeric window at all is DEGRADED.
import { spawn, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, mkdtempSync, readFileSync, rmSync, watch, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

const REPO_ROOT = fileURLToPath(new URL('../../../..', import.meta.url))
const WATCH = process.env.WT_QUOTA_WATCH_SCRIPT || join(REPO_ROOT, 'plugin/bin/wt-quota-watch.mjs')
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

const win = (pct: number, resetsAt: string | number = FUTURE) => ({ pct, resets_at: resetsAt, reset_local: 'Fri 06/11 04:00' })

interface Step { cache?: Record<string, unknown> | null, uuid?: string, advanceMs?: number }
/** Switch the login identity once, at an exact point of the watcher's own cache check. */
interface IdentitySwitch { when: 'during-cache-read' | 'after-cache-check', uuid: string }
interface RunOptions { instrument?: boolean, cycles?: number, accountKey?: string | null, fingerprint?: boolean, steps?: Step[], poll?: number, identitySwitch?: IdentitySwitch }
const fingerprint = (uuid: string) => createHash('sha256').update(uuid).digest('hex').slice(0, 8)

/**
 * Preload fragment (needs `fs`, `fsp`, `cache`, `identity`, `writeIdentity` in scope).
 * 'during-cache-read': the login changes while the cache file read is awaited.
 * 'after-cache-check': the login changes right after the first identity read that follows that cache read.
 */
function identitySwitchPreload(identitySwitch: IdentitySwitch | undefined) {
  if (!identitySwitch) return ''
  return `const identitySwitch = ${JSON.stringify(identitySwitch)};
let armed = false, switched = false;
const readFile = fsp.readFile, readFileSync = fs.readFileSync;
fsp.readFile = async function(path, ...args) {
  const result = await readFile.call(this, path, ...args);
  if (path === cache && !switched) {
    if (identitySwitch.when === 'during-cache-read') { switched = true; writeIdentity(identitySwitch.uuid) } else armed = true;
  }
  return result;
};
fs.readFileSync = function(path, ...args) {
  const result = readFileSync.call(this, path, ...args);
  if (armed && path === identity) { armed = false; switched = true; writeIdentity(identitySwitch.uuid) }
  return result;
};\n`
}

/** Change real cache/identity files at the watcher's own sleep boundary, without wall-clock races. */
function sequencePreload(root: string, accountKey: string | null, steps: Step[], identitySwitch?: IdentitySwitch) {
  const preload = join(root, 'steps.mjs')
  writeFileSync(preload, `import fs from 'node:fs';
import fsp from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
const root = ${JSON.stringify(root)}, steps = ${JSON.stringify(steps)};
// Built with the platform's own join, as the watcher builds them: compared by string equality below.
const cache = ${JSON.stringify(join(root, accountKey && accountKey !== 'login' ? `.quota-cache.${accountKey}.json` : '.quota-cache.json'))};
const identity = ${JSON.stringify(join(root, '.claude.json'))};
const sleepLog = ${JSON.stringify(join(root, 'sleeps'))};
const writeIdentity = (uuid) => fs.writeFileSync(identity, JSON.stringify({ oauthAccount: { accountUuid: uuid } }));
const append = fs.appendFileSync, now = Date.now();
let cycle = 0, offset = 0;
Date.now = () => now + offset;
fs.appendFileSync = function(path, ...args) {
  const result = append.call(this, path, ...args);
  if (path !== sleepLog) return result;
  const step = steps[cycle++] || {};
  offset += step.advanceMs || 0;
  if (step.uuid) writeIdentity(step.uuid);
  if (step.cache === null) fs.rmSync(cache, { force: true });
  else if (step.cache) fs.writeFileSync(cache, JSON.stringify({ at: Date.now(), data: { configDir: root, accountKey: ${JSON.stringify(accountKey ?? 'login')}, ...step.cache } }));
  return result;
};
${identitySwitchPreload(identitySwitch)}syncBuiltinESMExports();\n`)
  return `--import=${pathToFileURL(preload).href}`
}

/**
 * A copy of the real watcher that records its event maps (keys AND values) at every sleep boundary.
 * It rewrites only the sleep function's first line, so the poll logic under test is the shipped one.
 */
function instrumentedWatcher(root: string) {
  const source = readFileSync(WATCH, 'utf8').replace(/from '(\.[^']+)'/g,
    (_, specifier: string) => `from ${JSON.stringify(new URL(specifier, pathToFileURL(WATCH)).href)}`)
  const hook = "async function sleep(ms) {\n  appendFileSync(process.env.WT_TEST_SNAPSHOTS, JSON.stringify(Object.fromEntries(['lastPct', 'lastResetsAt', 'fired'].map((key) => [key, [...state[key].entries()]])" +
    "), (_key, value) => (value instanceof Set ? [...value] : value)) + '\\n')"
  const instrumented = source.replace('async function sleep(ms) {', hook)
  if (instrumented === source) throw new Error('the poll-boundary observation seam must be installed')
  const script = join(root, 'watch-instrumented.mjs')
  writeFileSync(script, instrumented)
  return script
}
const watchScript = (root: string, options: RunOptions) => (options.instrument ? instrumentedWatcher(root) : WATCH)
const readSnapshots = (root: string) => readFileSync(join(root, 'snapshots'), 'utf8').trim().split('\n').map((line) => JSON.parse(line) as Record<string, unknown>)

/**
 * Probe printing payloads[n] on its n-th call (the last one repeats), in an isolated config dir.
 * A payload's `__uuid` makes the probe switch the login identity while it runs, before it answers.
 */
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
const { __uuid, ...payload } = all[Math.min(n, all.length - 1)];
if (__uuid) writeFileSync(process.env.CLAUDE_CONFIG_DIR + '/.claude.json', JSON.stringify({ oauthAccount: { accountUuid: __uuid } }));
console.log(JSON.stringify({ configDir: process.env.CLAUDE_CONFIG_DIR, ...${JSON.stringify(identity)}, ...payload }));\n`)
  if (options.fingerprint) writeFileSync(join(root, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-fixture' } }))
  const res = spawnSync(process.execPath, [watchScript(root, options), '--probe', probe, '--poll', String(options.poll ?? 5), '--timeout', '3'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: {
       ...process.env,
       NODE_OPTIONS: sequencePreload(root, accountKey, options.steps ?? [], options.identitySwitch),
      ANTHROPIC_BASE_URL: '',
      ANTHROPIC_AUTH_TOKEN: '',
      WT_SESSION_ROLE: '',
      CLAUDE_CODE_OAUTH_TOKEN: '',
      CLAUDE_CONFIG_DIR: root,
      WT_QUOTA_WATCH_TEST_SLEEP_LOG: join(root, 'sleeps'),
      WT_TEST_SNAPSHOTS: join(root, 'snapshots'),
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
    const res = runSequence([{ five_hour: LOST_WINDOW, seven_day: win(40) }], { accountKey: null, fingerprint: true, cycles: 2 })
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
      expect(countOf(res.stdout, 'QUOTA 5h: 94% — crossed the 80% threshold')).toBe(1)
      expect(countOf(res.stdout, 'QUOTA 5h: 94% — crossed the 90% threshold')).toBe(1)
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

describe('recovery visibility', () => {
  it('names the watched windows exactly once on recovery after initial DEGRADED', () => {
    const res = runSequence([{}, { five_hour: win(10), seven_day: win(20) }, { five_hour: win(10), seven_day: win(20) }])
    expect(res.stdout).toContain('QUOTA WATCH DEGRADED')
    expect(res.stdout.split('\n').filter((line) => /^QUOTA WATCH ARMED: .* \| watching 5h,7d$/.test(line))).toHaveLength(1)
  })

  it('names the watched windows once again after an established watcher recovers', () => {
    const both = { five_hour: win(10), seven_day: win(20) }
    const res = runSequence([both, {}, both, both])
    expect(res.stdout.split('\n').filter((line) => /^QUOTA WATCH ARMED: .* \| watching 5h,7d$/.test(line))).toHaveLength(2)
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
  writeFileSync(join(root, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'uuid-fixture' } }))
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
    writeFileSync(join(root, '.quota-cache.json'), JSON.stringify({ at: Date.now(), data: { configDir: root, accountKey: 'login', accountFingerprint: fingerprint('uuid-fixture'), ...seed } }))
    writeFileSync(barrier, '')
    expect(await done).toBe(0)
    return { stdout, count: Number(readFileSync(counter, 'utf8')) }
  } finally { watcher.close(); child.kill('SIGKILL') }
}

describe('cache requirements survive partial live readings', () => {
  it('a partial live reading never shrinks the cache requirement for this account', () => {
    const res = runSequence([
      { five_hour: win(70), seven_day: win(40) },
      { seven_day: win(41) },
      { five_hour: win(94), seven_day: win(42) },
    ], { fingerprint: true, cycles: 4, steps: [{ cache: null }, { cache: { accountFingerprint: fingerprint('uuid-fixture'), seven_day: win(42) } }, { cache: { accountFingerprint: fingerprint('uuid-fixture'), seven_day: win(43) } }] })
    expect(res.count).toBe(4)
    expect(countOf(res.stdout, 'QUOTA 5h: 94% — crossed the 80% threshold')).toBe(1)
    expect(countOf(res.stdout, 'QUOTA 5h: 94% — crossed the 90% threshold')).toBe(1)
  })

  it('a continuously refreshed partial cache cannot postpone live discovery beyond one tolerance window', () => {
    const partial = { accountFingerprint: fingerprint('uuid-fixture'), seven_day: win(41) }
    const res = runSequence([{ seven_day: win(40) }, { five_hour: win(10), seven_day: win(42) }], {
      accountKey: 'login', fingerprint: true, cycles: 3,
      steps: [{ cache: partial, advanceMs: 899_999 }, { cache: partial, advanceMs: 1 }],
    })
    expect(res.count).toBe(2)
    expect(res.stdout).toContain('the 5-hour window is now reported by the probe')
  })
})

describe('partial-reading live recheck cadence', () => {
  it('caps an hourly poll at one cache tolerance window while a window is missing', () => {
    const res = runSequence([{ seven_day: win(40) }], { poll: 3600 })
    expect(res.sleeps).toEqual([900_000])
  })
  it('preserves the configured hourly cadence when both windows are reported', () => {
    const res = runSequence([{ five_hour: win(40), seven_day: win(40) }], { poll: 3600 })
    expect(res.sleeps).toEqual([3_600_000])
  })
})

describe('account and window histories stay independent', () => {
  it('a login switch rejects the previous account cache before baselining the new account', () => {
    const res = runSequence([{ seven_day: win(85, PAST) }, { seven_day: win(4) }], {
      accountKey: 'login', fingerprint: true, cycles: 3, steps: [{ uuid: 'uuid-new-account' }],
    })
    expect(res.count).toBe(2)
    expect(countOf(res.stdout, 'QUOTA ACCOUNT CHANGED:')).toBe(1)
    expect(res.stdout).not.toMatch(/QUOTA (RESET|DROP)/)
  })

  it('an unknown-identity drop consumes only the dropping window, preserving other crossings', () => {
    const res = runSequence([
      { five_hour: win(70), seven_day: win(85) }, { seven_day: win(85) },
      { five_hour: win(94), seven_day: win(4) }, { five_hour: win(94), seven_day: win(4) },
    ])
    expect(res.stdout).toContain('QUOTA DROP 7d: 4% (was 85%) — cause undetermined')
    expect(countOf(res.stdout, 'QUOTA 5h: 94% — crossed the 80% threshold')).toBe(1)
    expect(countOf(res.stdout, 'QUOTA 5h: 94% — crossed the 90% threshold')).toBe(1)
  })
})

describe('reset deadlines across unreported intervals', () => {
  for (const [key, other, label] of [['five_hour', 'seven_day', '5h'], ['seven_day', 'five_hour', '7d']] as const) {
    it(`${key}: a forward reset deadline during an unreported interval re-arms even with higher usage`, () => {
      const res = runSequence([
        { [key]: win(85, PAST), [other]: win(40) }, { [other]: win(40) },
        { [key]: win(94), [other]: win(40) }, { [key]: win(94), [other]: win(40) },
      ], { fingerprint: true })
      expect(countOf(res.stdout, `QUOTA RESET ${label}: 94% (was 85%)`)).toBe(1)
      expect(countOf(res.stdout, `QUOTA ${label}: 94% — crossed the 80% threshold`)).toBe(1)
      expect(countOf(res.stdout, `QUOTA ${label}: 94% — crossed the 90% threshold`)).toBe(1)
    })
  }

  it('a normal rising reading updates the stored deadline before a later percentage drop', () => {
    const res = runSequence([
      { five_hour: win(70, PAST), seven_day: win(40) },
      { five_hour: win(75), seven_day: win(40) },
      { five_hour: win(74), seven_day: win(40) },
    ], { fingerprint: true })
    expect(res.stdout).toContain('QUOTA DROP 5h: 74% (was 75%) — reset unverified: before the reported reset time')
    expect(res.stdout).not.toContain('QUOTA RESET 5h: 74%')
  })
})

// Astra round 4: a deadline that moves later BEFORE the previous one elapsed is a correction or an
// extension, not a completed reset; only an elapsed, finite previous deadline proves the window turned.
describe('a deadline advance is a reset only once the previous deadline has passed', () => {
  const LATER = new Date(Date.parse(FUTURE) + 3_600_000).toISOString()

  it('85@T -> 86@T+1h -> 86@T+1h before T: no RESET and no repeated 80% crossing', () => {
    const res = runSequence([
      { five_hour: win(85), seven_day: win(40) },
      { five_hour: win(86, LATER), seven_day: win(40) },
      { five_hour: win(86, LATER), seven_day: win(40) },
    ], { fingerprint: true })
    expect(res.stdout).not.toMatch(/QUOTA (RESET|DROP) 5h/)
    expect(res.stdout).not.toContain('crossed the 80% threshold')
  })

  it('85@future -> 4@later-future stays the unverified DROP', () => {
    const res = runSequence([
      { five_hour: win(85), seven_day: win(40) },
      { five_hour: win(4, LATER), seven_day: win(40) },
    ], { fingerprint: true })
    expect(res.stdout).toContain('QUOTA DROP 5h: 4% (was 85%) — reset unverified: before the reported reset time')
    expect(res.stdout).not.toContain('QUOTA RESET 5h')
  })

  for (const previous of [-1e308, '-1e308', '1e309']) {
    it(`a previous deadline ${String(previous)} that is no finite time never counts as advanced`, () => {
      const res = runSequence([
        { five_hour: win(85, previous), seven_day: win(40) },
        { five_hour: win(86), seven_day: win(40) },
      ], { fingerprint: true })
      expect(res.stdout).not.toMatch(/QUOTA (RESET|DROP) 5h/)
      expect(res.stdout).not.toContain('crossed the 80% threshold')
    })
  }
})

// Astra round 4: the identity that stamps and baselines a reading must be the one read around it.
describe('a reading is bound to the login identity read around it', () => {
  const SWITCH_DURING_PROBE = { __uuid: 'uuid-other-account', seven_day: win(85, PAST) }

  it('a login switch while the live probe runs writes no cache and baselines nothing', () => {
    const res = runSequence([SWITCH_DURING_PROBE], { accountKey: 'login', fingerprint: true, cycles: 1 })
    expect(existsSync(join(res.root, '.quota-cache.json'))).toBe(false)
    expect(armedLine(res.stdout)).not.toContain('watching')
    expect(res.stdout).toContain('QUOTA WATCH: the login account changed while the probe ran — reading discarded, probing again next poll')
  })

  it('a reading taken across a login switch never becomes the new account\'s baseline (no false RESET)', () => {
    const res = runSequence([SWITCH_DURING_PROBE, { seven_day: win(4) }], {
      accountKey: 'login', fingerprint: true, cycles: 2, steps: [{ cache: null }],
    })
    expect(res.count).toBe(2)
    expect(res.stdout).not.toMatch(/QUOTA (RESET|DROP)/)
  })

  it('a switch right after the cache check never baselines the cached reading under the new account', () => {
    const res = runSequence([{ seven_day: win(85, PAST) }, { seven_day: win(4) }], {
      accountKey: 'login', fingerprint: true, cycles: 3, identitySwitch: { when: 'after-cache-check', uuid: 'uuid-other-account' },
    })
    expect(res.count).toBe(2)
    expect(countOf(res.stdout, 'QUOTA ACCOUNT CHANGED:')).toBe(1)
    expect(res.stdout).not.toMatch(/QUOTA (RESET|DROP)/)
  })

  it('a switch during the awaited cache read rejects the cache and probes live', () => {
    const res = runSequence([{ seven_day: win(40) }, { seven_day: win(41) }], {
      accountKey: 'login', fingerprint: true, cycles: 2,
      steps: [{ cache: { accountFingerprint: fingerprint('uuid-fixture'), seven_day: win(99) } }],
      identitySwitch: { when: 'during-cache-read', uuid: 'uuid-other-account' },
    })
    expect(res.count).toBe(2)
    expect(res.stdout).not.toContain('99%')
  })
})

describe('point 5: the cache door requires every window any live reading of this account carried', () => {
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

describe('login cache fingerprint provenance', () => {
  for (const accountFingerprint of [undefined, null, fingerprint('uuid-foreign')]) {
    it(`rejects an unbound or foreign cache fingerprint ${String(accountFingerprint)}`, async () => {
      const res = await runWithSeededCache({ seven_day: win(40) }, { seven_day: win(99), accountFingerprint })
      expect(res.count).toBe(2)
      expect(res.stdout).not.toContain('99%')
    })
  }
})

const BUNDLED_PROBE = join(REPO_ROOT, 'plugin/bin/wt-quota-probe.mjs')

/** The real watcher driving the bundled probe, for a usage endpoint stubbed to answer `body`. */
function watchWithBundledProbe(body: Record<string, unknown> | Record<string, unknown>[], cycles = 1) {
  const root = mkdtempSync(join(tmpdir(), 'wt-quota-plan-bundled-'))
  roots.push(root)
  const stub = join(root, 'fetch-stub.mjs')
  const bodies = Array.isArray(body) ? body : [body]
  writeFileSync(stub, `import { readFileSync, writeFileSync } from 'node:fs';
globalThis.fetch = async () => {
  const counter = ${JSON.stringify(join(root, 'fetch-count'))};
  let n = 0; try { n = Number(readFileSync(counter, 'utf8')) } catch {}
  writeFileSync(counter, String(n + 1));
  const bodies = ${JSON.stringify(bodies)};
  return { ok: true, status: 200, json: async () => bodies[Math.min(n, bodies.length - 1)] };
};\n`)
  return spawnSync(process.execPath, [WATCH, '--probe', BUNDLED_PROBE, '--poll', '5', '--timeout', '3'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, NODE_OPTIONS: `--import=${pathToFileURL(stub).href}`, ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', WT_SESSION_ROLE: '', CLAUDE_CODE_OAUTH_TOKEN: 'stub-session', CLAUDE_CONFIG_DIR: root, WT_QUOTA_WATCH_TEST_SLEEP_LOG: join(root, 'sleeps'), WT_QUOTA_WATCH_TEST_MAX_CYCLES: String(cycles) },
  }).stdout
}

describe('the BUNDLED probe, against a usage endpoint without a five-hour window', () => {
  it.each([{}, { unknown: true }, { limits: {} }])('degrades on an unrecognised endpoint response %j, then recovers without stopping', (body) => {
    const stdout = watchWithBundledProbe([body, { seven_day: { utilization: 91 } }], 2)
    expect(stdout).toContain('QUOTA WATCH DEGRADED: probe output INVALID (missing window(s): five_hour,seven_day) (reported once)')
    expect(stdout).not.toContain('QUOTA WATCH STOPPING')
    expect(stdout).toMatch(/^QUOTA WATCH ARMED: .* \| watching 7d/m)
    expect(stdout).toContain('7d 91%')
  })

  for (const [name, body] of [['omits five_hour', { seven_day: { utilization: 40 } }], ['states five_hour: null', { five_hour: null, seven_day: { utilization: 40 } }]] as const) {
    it(`an endpoint that ${name} arms on the seven-day window and says five_hour is not reported`, () => {
      const stdout = watchWithBundledProbe(body)
      expect(armedLine(stdout)).toMatch(/ \| watching 7d$/)
      expect(stdout).toContain(FIVE_HOUR_NOT_REPORTED)
      expect(stdout).not.toContain('DEGRADED')
    })
  }
})

// Ported from the superseded duplicate card (1898619335): a reading the gate rejects is not an
// observation. Here a rejected reading is one with NO numeric window; it must neither repeat a
// crossing nor lose a reset, and must leave every event map exactly as it found it.
const REJECTED_READINGS: Array<[string, Record<string, unknown>]> = [
  ['seven_day null', { seven_day: null }],
  ['missing key', {}],
  ['seven_day null percentage', { seven_day: LOST_WINDOW }],
]
const DEGRADED_BOTH = /QUOTA WATCH DEGRADED: probe output INVALID \(missing window\(s\): five_hour,seven_day\)/

describe('a rejected live reading never changes any window\'s state', () => {
  for (const [variant, rejected] of REJECTED_READINGS) {
    it(`(${variant}) does not repeat a threshold crossing`, () => {
      const res = runSequence([{ seven_day: { pct: 79 } }, { seven_day: { pct: 81 } }, rejected, { seven_day: { pct: 81 } }], { fingerprint: true })
      const crossings = res.stdout.split('\n').filter((line) => line.includes('crossed the 80% threshold'))
      expect(crossings, `exactly one 80% crossing expected:\n${res.stdout}`).toHaveLength(1)
      expect(crossings[0]).toMatch(/^QUOTA 7d: 81% — crossed the 80% threshold/)
      expect(res.stdout).toMatch(DEGRADED_BOTH)
    })

    it(`(${variant}) keeps the next seven-day reset`, () => {
      const res = runSequence([{ seven_day: { pct: 79 } }, { seven_day: { pct: 81 } }, rejected, { seven_day: { pct: 4 } }], { fingerprint: true })
      expect(res.stdout, `the reset after a rejected reading must be reported:\n${res.stdout}`)
        .toMatch(/^QUOTA RESET 7d: 4% \(was 81%\) — new window, capacity available$/m)
    })

    it(`(${variant}) leaves every event map unchanged, values as well as keys`, () => {
      const res = runSequence([{ seven_day: { pct: 79 } }, { seven_day: { pct: 81 } }, rejected], { fingerprint: true, instrument: true })
      const snapshots = readSnapshots(res.root)
      expect(snapshots).toHaveLength(3)
      expect(JSON.stringify(snapshots[1]), 'control: the armed baseline holds a 7d entry').toContain('81')
      expect(snapshots[2]).toEqual(snapshots[1])
    })
  }

  it('a reading discarded because the login changed while the probe ran leaves every event map unchanged', () => {
    const res = runSequence([{ seven_day: win(40) }, { __uuid: 'uuid-other-account', seven_day: win(85, PAST) }], {
      accountKey: 'login', fingerprint: true, cycles: 2, instrument: true, steps: [{ cache: null }],
    })
    expect(res.stdout).toContain('reading discarded, probing again next poll')
    const snapshots = readSnapshots(res.root)
    expect(snapshots).toHaveLength(2)
    expect(JSON.stringify(snapshots[0]), 'control: the first poll baselined 7d at 40').toContain('40')
    expect(snapshots[1]).toEqual(snapshots[0])
  })
})

describe('a partial reading recovers from DEGRADED back to the normal poll', () => {
  for (const [name, shape] of UNREPORTED_SHAPES) {
    it(`five_hour ${name}: a live seven-day recovery resets the probe backoff`, () => {
      const healthy = withFiveHour(shape, { seven_day: { pct: 96 } })
      const res = runSequence([{}, healthy, healthy])
      expect(res.sleeps, 'a live seven-day recovery must reset probe backoff').toEqual([10_000, 5_000, 5_000])
      expect(countOf(res.stdout, 'QUOTA WATCH DEGRADED')).toBe(1)
      expect(res.stdout).toContain('7d 96%')
      expect(countOf(res.stdout, FIVE_HOUR_NOT_REPORTED)).toBe(1)
    })

    it(`five_hour ${name}: seven-day thresholds and a reset fire`, () => {
      const res = runSequence([10, 81, 4, 96].map((pct) => withFiveHour(shape, { seven_day: { pct } })), { fingerprint: true })
      expect(res.stdout).toContain('QUOTA 7d: 81% — crossed the 80% threshold')
      expect(res.stdout).toMatch(/QUOTA RESET 7d: 4% \(was 81%\)/)
      expect(res.stdout).toContain('QUOTA 7d: 96% — crossed the 95% threshold')
      expect(res.stdout).not.toContain('DEGRADED')
      expect(countOf(res.stdout, FIVE_HOUR_NOT_REPORTED)).toBe(1)
    })
  }
})

// Pins the CURRENT choice: a window that is present but malformed is treated exactly like a missing
// one (said once to be "not reported by the probe"), next to a numeric window, live and cached.
describe('one malformed window beside one numeric window', () => {
  const MALFORMED: Array<[string, unknown]> = [['a string pct', { pct: 'unavailable', resets_at: FUTURE }], ['an empty object', {}], ['an array', []]]
  for (const [name, shape] of MALFORMED) {
    it(`live: five_hour as ${name} is watched as seven-day only, said once, never DEGRADED`, () => {
      const res = runSequence([{ five_hour: shape, seven_day: win(70) }, { five_hour: shape, seven_day: win(91) }])
      expect(armedLine(res.stdout)).toMatch(/ \| watching 7d$/)
      expect(countOf(res.stdout, FIVE_HOUR_NOT_REPORTED)).toBe(1)
      expect(res.stdout).toContain('QUOTA 7d: 91% — crossed the 90% threshold')
      expect(res.stdout).not.toContain('DEGRADED')
    })

    it(`live: seven_day as ${name} is watched as five-hour only, said once, never DEGRADED`, () => {
      const res = runSequence([{ five_hour: win(70), seven_day: shape }, { five_hour: win(91), seven_day: shape }])
      expect(armedLine(res.stdout)).toMatch(/ \| watching 5h$/)
      expect(countOf(res.stdout, SEVEN_DAY_NOT_REPORTED)).toBe(1)
      expect(res.stdout).toContain('QUOTA 5h: 91% — crossed the 90% threshold')
      expect(res.stdout).not.toContain('DEGRADED')
    })

    it(`cached: a cache whose five_hour is ${name} is refused after a two-window reading, and the watcher probes live`, async () => {
      const res = await runWithSeededCache({ five_hour: win(10), seven_day: win(40) }, { five_hour: shape, seven_day: win(40) })
      expect(res.count).toBe(2)
    })

    it(`cached: after a seven-day-only live reading, a cache whose five_hour is ${name} is used`, async () => {
      const res = await runWithSeededCache({ five_hour: shape, seven_day: win(40) }, { five_hour: shape, seven_day: win(41) })
      expect(res.count).toBe(1)
      expect(res.stdout).not.toContain('DEGRADED')
    })
  }
})
