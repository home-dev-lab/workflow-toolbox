// quota-watch-plan-windows.test.ts — a plan WITHOUT a five-hour window is a usable reading.
//
// WHAT THIS PROTECTS: a subscription plan can drop its five-hour limit and be managed on the
// seven-day window alone. A probe states that with `five_hour: null`. The watcher used to reject such
// a reading whole as "missing window(s): five_hour", so it watched NOTHING: no seven-day crossing,
// no reset, no cache.
//
// What must still degrade is a reading that drops a window the plan HAS without saying so: a key
// the probe omitted, a malformed window, ANY window object without a usable percentage (the empty
// `{ pct: null, resets_at: null }` included, with or without `pctRaw`), and any reading without a
// usable seven-day window. Such a reading must also leave the window's crossing and reset history
// untouched (cross-family review, 2026-11-02).
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
  return { stdout: res.stdout, status: res.status, count, root }
}

const armedLine = (stdout: string) => stdout.split('\n').find((line) => line.startsWith('QUOTA WATCH ARMED')) ?? ''

describe('wt-quota-watch on a plan with no five-hour window', () => {
  it('arms on `five_hour: null`, says so in words, and reports a seven-day threshold crossing', () => {
    const res = runSequence([
      { five_hour: null, seven_day: win(70) },
      { five_hour: null, seven_day: win(91) },
    ])
    expect(armedLine(res.stdout)).toContain('the 5-hour window is not part of this plan')
    expect(res.stdout).toContain('QUOTA 7d: 91% — crossed the 90% threshold')
    expect(res.stdout).not.toContain('DEGRADED')
  })

  it('reports a seven-day RESET', () => {
    const res = runSequence([
      { five_hour: null, seven_day: win(85, PAST) },
      { five_hour: null, seven_day: win(4) },
    ], { fingerprint: true })
    expect(res.stdout).toMatch(/^QUOTA RESET 7d: 4% \(was 85%\)/m)
    expect(res.stdout).not.toContain('DEGRADED')
  })

  it('refills the shared login cache and is served from it on the next poll', () => {
    const res = runSequence([{ five_hour: null, seven_day: win(40) }], { accountKey: null, cycles: 2 })
    expect(armedLine(res.stdout)).toContain('the 5-hour window is not part of this plan')
    const cache = JSON.parse(readFileSync(join(res.root, '.quota-cache.json'), 'utf8'))
    expect(cache.data.seven_day.pct).toBe(40)
    // The second cycle read the cache instead of probing: one live call for two cycles.
    expect(res.count).toBe(1)
    expect(res.stdout).not.toContain('DEGRADED')
  })
})

describe('wt-quota-watch follows the five-hour window leaving and rejoining the plan', () => {
  it('watches the five-hour window again, without a restart, once the plan reports it', () => {
    const res = runSequence([
      { five_hour: null, seven_day: win(40) },
      { five_hour: win(85), seven_day: win(40) },
      { five_hour: win(92), seven_day: win(40) },
    ])
    expect(res.stdout).toMatch(/^QUOTA WATCH: the 5-hour window is part of this plan again — now watching it \| 5h 85%/m)
    expect(res.stdout).not.toContain('QUOTA 5h: 85% — crossed')
    expect(res.stdout).toContain('QUOTA 5h: 92% — crossed the 90% threshold')
    expect(res.stdout).not.toContain('DEGRADED')
  })

  it('says so when the five-hour window leaves the plan mid-run, and keeps watching seven days', () => {
    const res = runSequence([
      { five_hour: win(50), seven_day: win(40) },
      { five_hour: null, seven_day: win(40) },
      { five_hour: null, seven_day: win(82) },
    ])
    expect(armedLine(res.stdout)).not.toContain('not part of this plan')
    expect(res.stdout).toMatch(/^QUOTA WATCH: the 5-hour window is no longer part of this plan — watching 7d only/m)
    expect(res.stdout).toContain('QUOTA 7d: 82% — crossed the 80% threshold')
    expect(res.stdout).not.toContain('DEGRADED')
  })

  it('a plan with both windows arms without any absent-window wording (control)', () => {
    const res = runSequence([{ five_hour: win(10), seven_day: win(20) }], { cycles: 1 })
    expect(armedLine(res.stdout)).toMatch(/^QUOTA WATCH ARMED: thresholds=/)
    expect(res.stdout).not.toContain('part of this plan')
  })
})

describe('wt-quota-watch still degrades on a reading that silently drops a window', () => {
  const cases: Array<[string, Record<string, unknown>, string]> = [
    ['the probe omits the five_hour key', { seven_day: win(40) }, 'five_hour'],
    ['five_hour is malformed', { five_hour: { pct: 'high' }, seven_day: win(40) }, 'five_hour'],
    ['five_hour is not an object', { five_hour: 'none', seven_day: win(40) }, 'five_hour'],
    ['five_hour has a reset time but no percentage', { five_hour: { pct: null, resets_at: FUTURE }, seven_day: win(40) }, 'five_hour'],
    ['five_hour is an empty window object', { five_hour: LOST_WINDOW, seven_day: win(40) }, 'five_hour'],
    ['five_hour has a null pct contradicted by pctRaw', { five_hour: CONTRADICTED, seven_day: win(40) }, 'five_hour'],
    ['five_hour is { pct: null } alone', { five_hour: { pct: null }, seven_day: win(40) }, 'five_hour'],
    ['the probe omits the seven_day key', { five_hour: win(10) }, 'seven_day'],
    ['seven_day is an empty window object', { five_hour: win(10), seven_day: LOST_WINDOW }, 'seven_day'],
    ['seven_day is null', { five_hour: win(10), seven_day: null }, 'seven_day'],
  ]
  for (const [name, payload, missing] of cases) {
    it(`degrades when ${name}`, () => {
      const res = runSequence([payload], { cycles: 1 })
      expect(res.stdout).toContain(`QUOTA WATCH DEGRADED: probe output INVALID (missing window(s): ${missing})`)
      expect(res.stdout).not.toContain('part of this plan')
    })
  }
})

describe('wt-quota-watch keeps a window\'s history across an unusable reading of it', () => {
  // Astra's sequence (cross-family review, 2026-11-02): a false absence used to clear the 5h state,
  // then the returning 94 % was baselined as "already crossed" and the 80/90 % alerts never fired.
  it('70 -> unusable -> 94 -> 94 still emits the 80 and 90 crossings', () => {
    const res = runSequence([
      { five_hour: win(70), seven_day: win(40) },
      { five_hour: CONTRADICTED, seven_day: win(40) },
      { five_hour: win(94), seven_day: win(40) },
      { five_hour: win(94), seven_day: win(40) },
    ])
    expect(res.stdout).toContain('QUOTA 5h: 94% — crossed the 80% threshold')
    expect(res.stdout).toContain('QUOTA 5h: 94% — crossed the 90% threshold')
    expect(res.stdout).toContain('QUOTA WATCH DEGRADED: probe output INVALID (missing window(s): five_hour)')
    expect(res.stdout).not.toContain('part of this plan')
  })

  it('85 (reset time passed) -> unusable -> 4 still reports the reset', () => {
    const res = runSequence([
      { five_hour: win(85, PAST), seven_day: win(40) },
      { five_hour: LOST_WINDOW, seven_day: win(40) },
      { five_hour: win(4), seven_day: win(40) },
    ], { fingerprint: true })
    expect(res.stdout).toMatch(/^QUOTA RESET 5h: 4% \(was 85%\)/m)
    expect(res.stdout).not.toContain('part of this plan')
  })
})

/** Live baseline, then a login-cache reading seeded before the second cycle (which reads the cache first). */
async function runWithSeededCache(seed: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'wt-quota-plan-cache-'))
  roots.push(root)
  const counter = join(root, 'counter')
  const probe = join(root, 'probe.mjs')
  const sleeps = join(root, 'sleeps')
  const barrier = join(root, 'barrier')
  writeFileSync(probe, `import { readFileSync, writeFileSync } from 'node:fs';
let n = 0; try { n = Number(readFileSync(${JSON.stringify(counter)}, 'utf8')) } catch {}
writeFileSync(${JSON.stringify(counter)}, String(n + 1));
console.log(JSON.stringify({ configDir: process.env.CLAUDE_CONFIG_DIR, accountKey: 'login', five_hour: ${JSON.stringify(win(10))}, seven_day: ${JSON.stringify(win(40))} }));\n`)
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

describe('wt-quota-watch reads plan absence from the shared cache only when it is stated', () => {
  it('a cached reading that OMITS five_hour is not absence: the watcher probes live instead', async () => {
    const res = await runWithSeededCache({ seven_day: win(40) })
    expect(res.count).toBe(2)
    expect(res.stdout).not.toContain('part of this plan')
  })

  it('a cached empty five_hour object is not absence either', async () => {
    const res = await runWithSeededCache({ five_hour: LOST_WINDOW, seven_day: win(40) })
    expect(res.count).toBe(2)
    expect(res.stdout).not.toContain('part of this plan')
  })

  it('a cached `five_hour: null` IS absence (control: the cache door can read a stated absence)', async () => {
    const res = await runWithSeededCache({ five_hour: null, seven_day: win(40) })
    expect(res.count).toBe(1)
    expect(res.stdout).toMatch(/^QUOTA WATCH: the 5-hour window is no longer part of this plan/m)
  })
})

const BUNDLED_PROBE = join(REPO_ROOT, 'plugin/bin/wt-quota-probe.mjs')

/** A fetch stub answering `body`, in a fresh config dir. */
function endpointStub(body: Record<string, unknown>) {
  const root = mkdtempSync(join(tmpdir(), 'wt-quota-plan-bundled-'))
  roots.push(root)
  const stub = join(root, 'fetch-stub.mjs')
  writeFileSync(stub, `globalThis.fetch = async () => ({ ok: true, status: 200, json: async () => (${JSON.stringify(body)}) })\n`)
  return { root, stubUrl: pathToFileURL(stub).href }
}

/** The bundled probe's own stdout for an endpoint answering `body`. */
function projectWithBundledProbe(body: Record<string, unknown>) {
  const { root, stubUrl } = endpointStub(body)
  const res = spawnSync(process.execPath, ['--import', stubUrl, BUNDLED_PROBE], { encoding: 'utf8', env: { ...process.env, CLAUDE_CONFIG_DIR: root, CLAUDE_CODE_OAUTH_TOKEN: 'stub-session' } })
  return JSON.parse(res.stdout)
}

/** The real watcher driving the bundled probe, for an endpoint answering `body`. */
function watchWithBundledProbe(body: Record<string, unknown>) {
  const { root, stubUrl } = endpointStub(body)
  return spawnSync(process.execPath, [WATCH, '--probe', BUNDLED_PROBE, '--poll', '5', '--timeout', '3'], {
    encoding: 'utf8',
    timeout: 20_000,
    env: { ...process.env, NODE_OPTIONS: `--import=${stubUrl}`, ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', WT_SESSION_ROLE: '', CLAUDE_CODE_OAUTH_TOKEN: 'stub-session', CLAUDE_CONFIG_DIR: root, WT_QUOTA_WATCH_TEST_SLEEP_LOG: join(root, 'sleeps'), WT_QUOTA_WATCH_TEST_MAX_CYCLES: '1' },
  }).stdout
}

describe('wt-quota-watch on the BUNDLED probe, against the usage endpoint\'s two shapes', () => {
  it('the probe projects an explicit null as null and an omitted key as omitted', () => {
    expect(projectWithBundledProbe({ five_hour: null, seven_day: { utilization: 40 } })).toMatchObject({ five_hour: null, seven_day: { pct: 40 } })
    expect(Object.hasOwn(projectWithBundledProbe({ seven_day: { utilization: 40 } }), 'five_hour')).toBe(false)
    expect(projectWithBundledProbe({ five_hour: { utilization: 7 }, seven_day: { utilization: 40 } }).five_hour).toMatchObject({ pct: 7 })
  })

  it('an endpoint that OMITS five_hour degrades: a dropped window is never read as plan absence', () => {
    const stdout = watchWithBundledProbe({ seven_day: { utilization: 40 } })
    expect(stdout).toContain('QUOTA WATCH DEGRADED: probe output INVALID (missing window(s): five_hour)')
    expect(stdout).not.toContain('part of this plan')
  })

  it('an endpoint that states `five_hour: null` arms on the seven-day window', () => {
    const stdout = watchWithBundledProbe({ five_hour: null, seven_day: { utilization: 40 } })
    expect(armedLine(stdout)).toContain('the 5-hour window is not part of this plan')
    expect(stdout).not.toContain('DEGRADED')
  })
})
