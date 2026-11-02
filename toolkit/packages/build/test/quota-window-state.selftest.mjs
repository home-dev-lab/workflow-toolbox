import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { test } from 'node:test'
import { hasCompleteWindows, WATCHED_WINDOW_KEYS } from '../../../../plugin/bin/lib/quota-window-completeness.mjs'

const WATCH = process.env.WT_QUOTA_WATCH_TEST_SCRIPT || fileURLToPath(new URL('../../../../plugin/bin/wt-quota-watch.mjs', import.meta.url))
const ACCOUNT_KEY = 'token-fixture123fixture123'
const absentWindows = [{}, { five_hour: null }, { five_hour: { pct: null, pctRaw: null, resets_at: null } }]

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
  if (${cache}) writeFileSync(join(cfg, '.quota-cache.${ACCOUNT_KEY}.json'), JSON.stringify({ at: Date.now(), data: reading(next) }))
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

test('a malformed present optional window remains degraded instead of reporting complete', () => {
  const reading = { five_hour: { pct: 'unavailable', resets_at: '2026-11-03T00:00:00Z' }, seven_day: { pct: 38 } }
  const result = runPolls(Array.from({ length: 12 }, () => reading))
  assert.match(result.stdout, /QUOTA WATCH DEGRADED/, 'a malformed optional measurement must not report complete')
  assert.match(result.stdout, /still blind after/)
  assert.doesNotMatch(result.stdout, /QUOTA STATUS/)
})

for (const [label, options, account] of [
  ['reset', {}, {}], ['unknown account drop', { fingerprint: false }, {}],
  ['account change', {}, { fixtureAccount: 'another-fixture-account' }],
]) {
  test(`five-hour thresholds rearm after disappearance during ${label}`, () => {
    const result = runPolls([
      { five_hour: { pct: 96 }, seven_day: { pct: 81 } },
      { ...account, five_hour: null, seven_day: { pct: 4 } },
      { ...account, five_hour: { pct: 97 }, seven_day: { pct: 5 } },
    ], options)
    assert.match(result.stdout, /QUOTA 5h: 97% — crossed the 95% threshold/,
      `five-hour thresholds must rearm after disappearance during ${label}`)
    if (label === 'account change') assert.match(result.stdout, /QUOTA ACCOUNT CHANGED/)
    if (label === 'reset') assert.match(result.stdout, /QUOTA RESET 7d/)
    if (label === 'unknown account drop') assert.match(result.stdout, /cause undetermined/)
  })
}

test('a malformed optional cache window falls through to live measurement', () => {
  const result = runPolls([
    { five_hour: { pct: 96 }, seven_day: { pct: 81 } },
    { five_hour: { pct: 'unavailable' }, seven_day: { pct: 38 } },
  ], { cache: true })
  assert.equal(result.probes, 2, 'a malformed optional cache measurement must not be trusted')
  assert.match(result.stdout, /QUOTA WATCH DEGRADED/)
})

// A reading the completeness gate rejects is not an observation: required-window history
// survives it, so recovery neither repeats a crossing nor loses a reset.
const rejectedSevenDay = [['null', { seven_day: null }], ['missing key', {}],
  ['null percentage', { seven_day: { pct: null, pctRaw: null, resets_at: null } }]]
for (const [variant, rejected] of rejectedSevenDay) {
  test(`a rejected live reading (seven_day ${variant}) does not repeat a threshold crossing`, () => {
    const result = runPolls([{ seven_day: { pct: 79 } }, { seven_day: { pct: 81 } }, rejected, { seven_day: { pct: 81 } }])
    const crossings = result.stdout.split('\n').filter(line => line.includes('crossed the 80% threshold'))
    assert.equal(crossings.length, 1, `exactly one 80% crossing expected:\n${result.stdout}`)
    assert.match(crossings[0], /^QUOTA 7d: 81% — crossed the 80% threshold/)
    assert.match(result.stdout, /QUOTA WATCH DEGRADED: probe output INVALID \(missing window\(s\): seven_day\)/)
  })
  test(`a rejected live reading (seven_day ${variant}) keeps the next seven-day reset`, () => {
    const result = runPolls([{ seven_day: { pct: 79 } }, { seven_day: { pct: 81 } }, rejected, { seven_day: { pct: 4 } }])
    assert.match(result.stdout, /^QUOTA RESET 7d: 4% \(was 81%\) — new window, capacity available$/m,
      `the reset after a rejected reading must be reported:\n${result.stdout}`)
  })
}

function assertRejectedUnchanged(index, snapshots, context) {
  assert.ok(index > 0, `${context}: the family never rejects its baseline reading`)
  assert.deepEqual(snapshots[index], snapshots[index - 1], `${context}: rejected poll ${index} must not mutate event state`)
}

function assertAbsentState(readings, snapshots, context) {
  assert.equal(snapshots.length, readings.length, context)
  for (const [index, reading] of readings.entries()) {
    if (!hasCompleteWindows(reading)) { assertRejectedUnchanged(index, snapshots, context); continue }
    for (const key of WATCHED_WINDOW_KEYS) {
      if (reading[key] != null && reading[key].pct !== null) continue
      for (const [map, keys] of Object.entries(snapshots[index])) {
        assert.ok(!keys.includes(key), `${context}: poll ${index} absent ${key} must have no ${map} state`)
      }
    }
  }
}

function checkPathCase(cache, identity, seven_day, absent) {
  const account = identity === 'changed' ? { fixtureAccount: 'another-fixture-account' } : {}
  const readings = [
    { five_hour: { pct: 96 }, seven_day: { pct: 81 } },
    { ...account, ...absent, seven_day },
    { ...account, five_hour: { pct: 97 }, seven_day: { pct: 83 } },
  ]
  const result = runPolls(readings, { cache, fingerprint: identity !== 'unknown' })
  assertAbsentState(readings, result.snapshots, JSON.stringify({ cache, identity, seven_day, absent }))
  let expectedProbes = 3
  if (cache) expectedProbes = typeof seven_day?.pct === 'number' ? 1 : 2
  assert.equal(result.probes, expectedProbes, 'the family must exercise the selected cache/live path')
}

test('absent-window event state is empty at every poll boundary across the path family', () => {
  for (const cache of [false, true]) {
    for (const identity of ['same', 'unknown', 'changed']) {
      for (const seven_day of [{ pct: 82 }, { pct: 4 }, null, { pct: 'unavailable' }]) {
        for (const absent of absentWindows) {
          checkPathCase(cache, identity, seven_day, absent)
        }
      }
    }
  }
})

test('help explicitly describes five-hour usage as optional', () => {
  const result = spawnSync(process.execPath, [WATCH, '--help'], { encoding: 'utf8' })
  assert.equal(result.status, 0)
  assert.match(result.stdout, /optional five-hour/, 'help must name the optional five-hour window')
})
