import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'

const WATCH = process.env.WT_QUOTA_WATCH_TEST_SCRIPT || fileURLToPath(new URL('../../../../plugin/bin/wt-quota-watch.mjs', import.meta.url))
const ACCOUNT_KEY = 'token-fixture123fixture123'

// Observe the real event maps at every sleep boundary, without adding a shipped test seam.
function instrumentWatcher(cfg) {
  const source = readFileSync(WATCH, 'utf8').replace(/from '(\.[^']+)'/g,
    (_, specifier) => `from ${JSON.stringify(new URL(specifier, pathToFileURL(WATCH)).href)}`)
  const instrumented = source.replace('async function sleep(ms) {',
    `async function sleep(ms) {\n  pollFinished(state)`)
  assert.notEqual(instrumented, source, 'the poll-boundary observation seam must be installed')
  const script = join(cfg, 'watch.mjs')
  writeFileSync(script, instrumented.replace("import { spawn }", () => `import { pollFinished } from ${JSON.stringify(pathToFileURL(join(cfg, 'fixture.mjs')).href)}\nimport { spawn }`))
  return script
}

function fixtureSource(cfg, readings, cache, fingerprint) {
  return `
import { createHash } from 'node:crypto'
import { appendFileSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
const cfg = ${JSON.stringify(cfg)}
const readings = ${JSON.stringify(readings)}
export function index() { try { return Number(readFileSync(join(cfg, 'cycle'), 'utf8')) } catch { return 0 } }
export function reading(n) { return { configDir: cfg, accountKey: '${ACCOUNT_KEY}', ...readings[n] } }
export function prepare(n) {
  if (${fingerprint}) writeFileSync(join(cfg, '.claude.json'), JSON.stringify({ oauthAccount: { accountUuid: readings[n].fixtureAccount || 'fixture-account' } }))
}
export function pollFinished(state) {
  const maps = Object.fromEntries(['lastPct', 'lastResetsAt', 'fired'].map(key => [key, [...state[key].keys()]]))
  appendFileSync(join(cfg, 'snapshots'), JSON.stringify(maps) + '\\n')
  const next = index() + 1
  writeFileSync(join(cfg, 'cycle'), String(next))
  if (next >= readings.length) return
  prepare(next)
  // The watcher uses a cached reading only when it carries the login's fingerprint (card 1899394115301279304):
  // without it every cache case would silently fall through to a live probe and prove nothing.
  if (${cache}) writeFileSync(join(cfg, '.quota-cache.${ACCOUNT_KEY}.json'), JSON.stringify({ at: Date.now(), data: { ...reading(next), accountFingerprint: fingerprintOf(next) } }))
}
function fingerprintOf(n) {
  return createHash('sha256').update(readings[n].fixtureAccount || 'fixture-account').digest('hex').slice(0, 8)
}
prepare(0)
`
}

function runPolls(readings, { cache = false, fingerprint = true } = {}) {
  const cfg = mkdtempSync(join(tmpdir(), 'wt-quota-state-'))
  try {
    writeFileSync(join(cfg, 'fixture.mjs'), fixtureSource(cfg, readings, cache, fingerprint))
    const probe = join(cfg, 'probe.mjs')
    writeFileSync(probe, `import { appendFileSync } from 'node:fs'
import { index, reading, prepare } from './fixture.mjs'
appendFileSync(${JSON.stringify(join(cfg, 'probes'))}, 'probe\\n')
prepare(index())
console.log(JSON.stringify(reading(index())))`)
    const result = spawnSync(process.execPath, [instrumentWatcher(cfg), '--probe', probe, '--poll', '5', '--timeout', '3'], {
      encoding: 'utf8', timeout: 60_000,
      env: { ...process.env, ANTHROPIC_BASE_URL: '', ANTHROPIC_AUTH_TOKEN: '', WT_SESSION_ROLE: '',
        CLAUDE_CONFIG_DIR: cfg, CLAUDE_CODE_OAUTH_TOKEN: '', WT_QUOTA_WATCH_ALLOW_DUPLICATE: '1',
        WT_QUOTA_WATCH_TEST_SLEEP_LOG: join(cfg, 'sleeps'), WT_QUOTA_WATCH_TEST_SLEEP_BARRIER: '',
        WT_QUOTA_WATCH_TEST_MAX_CYCLES: String(readings.length) },
    })
    assert.equal(result.status, 0, result.stderr)
    return { stdout: result.stdout,
      snapshots: readFileSync(join(cfg, 'snapshots'), 'utf8').trim().split('\n').map(line => JSON.parse(line)),
      probes: readFileSync(join(cfg, 'probes'), 'utf8').trim().split('\n').length }
  } finally { rmSync(cfg, { recursive: true, force: true }) }
}

test('control: a complete cached reading is used, so the cache path is really exercised', () => {
  const result = runPolls([
    { five_hour: { pct: 96 }, seven_day: { pct: 81 } },
    { five_hour: { pct: 97 }, seven_day: { pct: 82 } },
  ], { cache: true })
  assert.equal(result.probes, 1, 'the second reading must come from the cache')
})

test('a malformed optional cache window falls through to live measurement', () => {
  const result = runPolls([
    { five_hour: { pct: 96 }, seven_day: { pct: 81 } },
    { five_hour: { pct: 'unavailable' }, seven_day: { pct: 38 } },
  ], { cache: true })
  assert.equal(result.probes, 2, 'a malformed optional cache measurement must not be trusted')
})

// A reading with no numeric window is rejected and is not an observation: window history
// survives it, so recovery neither repeats a crossing nor loses a reset.
const rejectedSevenDay = [['null', { seven_day: null }], ['missing key', {}],
  ['null percentage', { seven_day: { pct: null, pctRaw: null, resets_at: null } }]]
for (const [variant, rejected] of rejectedSevenDay) {
  test(`a rejected live reading (seven_day ${variant}) does not repeat a threshold crossing`, () => {
    const result = runPolls([{ seven_day: { pct: 79 } }, { seven_day: { pct: 81 } }, rejected, { seven_day: { pct: 81 } }])
    const crossings = result.stdout.split('\n').filter(line => line.includes('crossed the 80% threshold'))
    assert.equal(crossings.length, 1, `exactly one 80% crossing expected:\n${result.stdout}`)
    assert.match(crossings[0], /^QUOTA 7d: 81% — crossed the 80% threshold/)
    assert.match(result.stdout, /QUOTA WATCH DEGRADED: probe output INVALID \(missing window\(s\): five_hour,seven_day\)/)
  })
  test(`a rejected live reading (seven_day ${variant}) keeps the next seven-day reset`, () => {
    const result = runPolls([{ seven_day: { pct: 79 } }, { seven_day: { pct: 81 } }, rejected, { seven_day: { pct: 4 } }])
    assert.match(result.stdout, /^QUOTA RESET 7d: 4% \(was 81%\) — new window, capacity available$/m,
      `the reset after a rejected reading must be reported:\n${result.stdout}`)
  })
}

test('help explicitly describes five-hour usage as optional', () => {
  const result = spawnSync(process.execPath, [WATCH, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /optional five-hour/, 'help must name the optional five-hour window')
})
