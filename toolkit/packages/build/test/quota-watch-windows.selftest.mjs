import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { test } from 'node:test'

const WATCH = process.env.WT_QUOTA_WATCH_TEST_SCRIPT || fileURLToPath(new URL('../../../../plugin/bin/wt-quota-watch.mjs', import.meta.url))
const absentOptionalWindows = [
  ['missing', {}],
  ['null window', { five_hour: null }],
  ['null pct', { five_hour: { pct: null, resets_at: null } }],
]

function runReadings(readings) {
  const cfg = mkdtempSync(join(tmpdir(), 'wt-quota-windows-'))
  try {
    const probe = join(cfg, 'probe.mjs')
    const sleepLog = join(cfg, 'sleeps.log')
    writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: 'fixture-account' } }))
    writeFileSync(probe, `
import { readFileSync, writeFileSync } from 'node:fs'
const counter = ${JSON.stringify(join(cfg, 'counter'))}
let n = 0; try { n = Number(readFileSync(counter, 'utf8')) } catch {}
writeFileSync(counter, String(n + 1))
const readings = ${JSON.stringify(readings)}
console.log(JSON.stringify({ configDir: process.env.CLAUDE_CONFIG_DIR, accountKey: 'token-fixture123fixture123', ...readings[Math.min(n, readings.length - 1)] }))
`)
    const result = spawnSync(process.execPath, [WATCH, '--probe', probe, '--poll', '5', '--timeout', '3'], {
      encoding: 'utf8', timeout: 30_000,
      env: { ...process.env, ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', WT_SESSION_ROLE: '',
        CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_OAUTH_TOKEN: '', WT_QUOTA_WATCH_ALLOW_DUPLICATE: '1',
        WT_QUOTA_WATCH_TEST_SLEEP_LOG: sleepLog, WT_QUOTA_WATCH_TEST_SLEEP_BARRIER: '',
        WT_QUOTA_WATCH_TEST_MAX_CYCLES: String(readings.length) },
    })
    assert.equal(result.status, 0, result.stderr)
    return { stdout: result.stdout, sleeps: readFileSync(sleepLog, 'utf8').trim().split('\n').map(Number) }
  } finally { rmSync(cfg, { recursive: true, force: true }) }
}

for (const [label, optional] of absentOptionalWindows) {
  test(`fresh seven-day usage is healthy with ${label} five-hour data`, () => {
    const result = runReadings([{ ...optional, seven_day: { pct: 96 } }])
    assert.doesNotMatch(result.stdout, /QUOTA WATCH DEGRADED/)
    assert.match(result.stdout, /7d 96%/)
    assert.doesNotMatch(result.stdout, /5h|five.hour/i)
    assert.deepEqual(result.sleeps, [5_000])
  })

  test(`seven-day usage clears degraded state with ${label} five-hour data`, () => {
    const healthy = { ...optional, seven_day: { pct: 96 } }
    const result = runReadings([{}, healthy, healthy])
    assert.deepEqual(result.sleeps, [10_000, 5_000, 5_000], 'a live seven-day recovery must reset probe backoff')
    assert.equal((result.stdout.match(/QUOTA WATCH DEGRADED/g) || []).length, 1)
    assert.match(result.stdout, /7d 96%/)
    assert.doesNotMatch(result.stdout, /5h|five.hour/i)
  })

  test(`seven-day thresholds and resets fire with ${label} five-hour data`, () => {
    const result = runReadings([10, 81, 4, 96].map((pct) => ({ ...optional, seven_day: { pct } })))
    assert.match(result.stdout, /QUOTA 7d: 81% — crossed the 80% threshold/)
    assert.match(result.stdout, /QUOTA RESET 7d: 4% \(was 81%\)/)
    assert.match(result.stdout, /QUOTA 7d: 96% — crossed the 95% threshold/)
    assert.doesNotMatch(result.stdout, /QUOTA WATCH DEGRADED|5h|five.hour/i)
  })
}

for (const [label, required] of [['missing', {}], ['null window', { seven_day: null }], ['null pct', { seven_day: { pct: null } }]]) {
  test(`numeric five-hour usage stays degraded with ${label} seven-day data`, () => {
    const result = runReadings(Array.from({ length: 12 }, () => ({ five_hour: { pct: 95 }, ...required })))
    assert.match(result.stdout, /missing window\(s\): seven_day/)
    assert.match(result.stdout, /QUOTA WATCH DEGRADED: still blind after/)
    assert.doesNotMatch(result.stdout, /QUOTA STATUS/)
    assert.ok(result.sleeps.every((ms) => ms > 5_000))
  })
}

test('both numeric windows retain their threshold and reset events', () => {
  const result = runReadings([10, 81, 4, 96].map((pct) => ({ five_hour: { pct }, seven_day: { pct } })))
  for (const label of ['5h', '7d']) {
    assert.ok(result.stdout.includes(`QUOTA ${label}: 81% — crossed the 80% threshold`))
    assert.ok(result.stdout.includes(`QUOTA RESET ${label}: 4% (was 81%)`))
    assert.ok(result.stdout.includes(`QUOTA ${label}: 96% — crossed the 95% threshold`))
  }
  assert.doesNotMatch(result.stdout, /QUOTA WATCH DEGRADED/)
})
