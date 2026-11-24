import assert from 'node:assert/strict'
import { mkdirSync, readFileSync, readdirSync, rmSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { test } from 'node:test'
import { events, fixture, fresh, live, routing, scanner } from './helpers/launcher-fixtures.mjs'

test('delegate lane completion is silent to main and published once', (t) => {
  const f = fixture(t); live(f)
  const s = scanner(f); s.sweep(); s.sweep()
  assert.deepEqual(s.lines, [])
  assert.equal(readdirSync(path.join(f.box, 'pending')).length, 1)
  assert.match(events.takeLauncherEvent('delegate', f.options)?.line, /^LANE exited:.*launcher-agent=delegate$/)
  assert.deepEqual(s.errors, [])
})

test('main lane completion keeps its single-line notice', (t) => {
  const f = fixture(t); delete f.record.launcherAgentId
  const s = scanner(f); s.sweep(); s.sweep()
  assert.equal(s.lines.length, 1)
  assert.match(s.lines[0], /^LANE exited: owner=session /)
})

test('a completed launcher falls back once, after pending publication', (t) => {
  const f = fixture(t); live(f)
  const s = scanner(f); s.sweep(); live(f, true); s.sweep(); s.sweep()
  assert.equal(s.lines.length, 1)
  assert.match(s.lines[0], /orphaned-launcher=delegate/)
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})

test('a consumed lane exit never echoes to main after launcher completion', (t) => {
  const f = fixture(t); live(f)
  const s = scanner(f); s.sweep()
  assert.ok(events.takeLauncherEvent('delegate', f.options))
  live(f, true); s.sweep()
  assert.deepEqual(s.lines, [])
})

test('orphan fallback survives the main archive watermark and restart', (t) => {
  const f = fixture(t); live(f, true); f.through = { runId: 'later', at: f.options.now + 1 }
  const s = scanner(f); s.sweep()
  assert.equal(s.lines.length, 1)
  const restarted = scanner(f); restarted.sweep()
  assert.deepEqual(restarted.lines, [])
})

test('missing launcher receives its own monotonic two-minute grace', (t) => {
  const f = fixture(t); let monotonic = 0
  f.options.monotonicClock = () => monotonic
  const s = scanner(f); s.sweep()
  f.options.now += 3_600_000; monotonic = 119_999; s.sweep()
  assert.deepEqual(s.lines, [], 'wall clock jumps cannot expire monotonic grace')
  f.options.now -= 7_200_000; monotonic = 120_001; s.sweep()
  assert.equal(s.lines.length, 1)
})

test('newly missing liveness starts grace at disappearance', (t) => {
  const f = fixture(t); live(f)
  const s = scanner(f); s.sweep(); f.options.now += 3_600_000
  rmSync(path.join(f.options.livenessDir, 'delegate.json')); s.sweep()
  assert.deepEqual(s.lines, [])
  f.options.now += 120_001; s.sweep()
  assert.equal(s.lines.length, 1)
})

test('pending lane exits survive vanished records and historical lookback', (t) => {
  const f = fixture(t); live(f)
  scanner(f).sweep(); f.record.ownerSessionId = 'foreign'
  f.options.now += 2 * 24 * 3_600_000; live(f, true)
  const s = scanner(f); s.sweep(); s.sweep()
  assert.equal(s.lines.length, 1)
  assert.match(s.lines[0], /orphaned-launcher=delegate/)
})

test('a present but non-consuming launcher eventually falls back', (t) => {
  const f = fixture(t); live(f)
  const s = scanner(f); s.sweep(); f.options.now += 3_420_001; s.sweep()
  assert.equal(s.lines.length, 1)
})

test('main orphan delivery rechecks an intervening delegate consumption', (t) => {
  const f = fixture(t); live(f, true)
  const routed = routing.routeLauncherEvent(f.record, { key: 'exit', line: 'LANE exited' }, f.options)
  events.takeLauncherEvent('delegate', f.options)
  assert.equal(routing.deliverLauncherRoute(routed, () => assert.fail('already consumed')), false)
})

test('corrupt liveness uses named main fallback and acknowledgement', (t) => {
  const f = fixture(t), reasons = []
  writeFileSync(path.join(f.options.livenessDir, 'delegate.json'), '{bad')
  const s = scanner(f, { reportReason: (line) => { reasons.push(line) } }); s.sweep(); s.sweep()
  assert.equal(s.lines.length, 1)
  assert.match(reasons.join('\n'), /launcher-routing-failed/)
  assert.equal(events.takeLauncherEvent('delegate', f.options), null)
})

for (const state of ['exited', 'abandoned', 'launch-failed', 'running', 'decision-needed']) {
  for (const worker of ['gone', 'running', 'unknown']) for (const child of ['gone', 'running', 'unknown']) {
    test(`completion classification ${state}, worker=${worker}, child=${child}`, (t) => {
      const f = fixture(t); delete f.record.launcherAgentId; f.record.state = state
      const s = scanner(f, { classifyLane: () => ({ worker, child }) }); s.sweep(); s.sweep()
      const terminal = ['exited', 'abandoned', 'launch-failed'].includes(state)
      assert.equal(s.lines.length, Number(terminal || (worker === 'gone' && child === 'gone')))
    })
  }
}

for (const ownerSessionId of [null, undefined, '', 'foreign', 'session']) {
  for (const launcher of [null, 'delegate']) {
    test(`completion ownership session=${String(ownerSessionId)}, launcher=${launcher}`, (t) => {
      const f = fixture(t); live(f)
      f.record.ownerSessionId = ownerSessionId; f.record.launcherAgentId = launcher
      const s = scanner(f); s.sweep()
      assert.equal(s.lines.length, Number(ownerSessionId === 'session' && !launcher))
      assert.equal(Boolean(events.takeLauncherEvent('delegate', f.options)), ownerSessionId === 'session' && Boolean(launcher))
    })
  }
}

for (const artefact of ['spool', 'lock', 'malformed-claim', 'all']) {
  test(`migration ignores ${artefact} without obstructing lane exits`, (t) => {
    const f = fixture(t), root = path.dirname(f.box), reasons = []
    mkdirSync(root, { mode: 0o700 })
    if (['spool', 'all'].includes(artefact)) writeFileSync(path.join(root, 'delegate.jsonl'), '{legacy torn')
    if (['lock', 'all'].includes(artefact)) mkdirSync(path.join(root, 'delegate.jsonl.lock'))
    if (['malformed-claim', 'all'].includes(artefact)) writeFileSync(path.join(root, 'delegate.jsonl.bad.claim'), '{bad')
    const options = { ...f.options, reportReason: (line) => { reasons.push(line) } }
    events.appendLauncherEvent('delegate', { key: 'exit', line: 'LANE exited' }, options)
    assert.equal(events.takeLauncherEvent('delegate', options)?.line, 'LANE exited')
    assert.match(reasons.join('\n'), /launcher-legacy-ignored/)
  })
}

test('done retention removes seven-day history but never pending delivery', (t) => {
  const f = fixture(t)
  events.appendLauncherEvent('delegate', { key: 'done', line: 'done' }, f.options)
  events.takeLauncherEvent('delegate', f.options)
  const name = readdirSync(path.join(f.box, 'done'))[0], old = new Date(f.options.now - 8 * 24 * 3_600_000)
  utimesSync(path.join(f.box, 'done', name), old, old)
  events.appendLauncherEvent('delegate', { key: 'pending', line: 'pending' }, f.options)
  assert.deepEqual(readdirSync(path.join(f.box, 'done')), [])
  assert.equal(events.takeLauncherEvent('delegate', f.options)?.line, 'pending')
})

for (const owner of ['missing', 'malformed', 'live']) {
  test(`a ${owner} claim owner is never reclaimed by age`, (t) => {
    const f = fixture(t), reasons = []
    events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, f.options)
    const name = readdirSync(path.join(f.box, 'pending'))[0], directory = path.join(f.box, 'claimed-unknown')
    mkdirSync(directory, { mode: 0o700 })
    const result = fresh(f, `fs.renameSync(${JSON.stringify(path.join(f.box, 'pending', name))},${JSON.stringify(path.join(directory, name))});`)
    assert.equal(result.status, 0)
    if (owner !== 'missing') writeFileSync(path.join(directory, 'owner.json'), owner === 'malformed' ? '{bad' : JSON.stringify({ pid: process.pid }))
    const old = new Date(0); utimesSync(directory, old, old)
    assert.equal(events.takeLauncherEvent('delegate', { ...f.options, reportReason: (line) => { reasons.push(line) } }), null)
    assert.equal(readFileSync(path.join(directory, name), 'utf8').includes('"line":"A"'), true)
    assert.match(reasons.join('\n'), /reader-(?:owner|liveness)-unknown/)
  })
}

for (const target of ['root', 'launcher', 'pending', 'done', 'tmp', 'keys']) {
  test(`private storage refuses a ${target} symlink`, { skip: process.platform === 'win32' }, (t) => {
    const f = fixture(t), reasons = [], victim = path.join(f.root, 'victim')
    mkdirSync(victim)
    const root = path.dirname(f.box)
    if (target !== 'root') mkdirSync(root, { mode: 0o700 })
    if (!['root', 'launcher'].includes(target)) mkdirSync(f.box, { mode: 0o700 })
    const link = target === 'root' ? root : target === 'launcher' ? f.box : path.join(f.box, target)
    symlinkSync(victim, link)
    const result = events.appendLauncherEvent('delegate', { key: 'A', line: 'A' }, { ...f.options, reportReason: (line) => { reasons.push(line) } })
    assert.equal(result.ok, false)
    assert.deepEqual(readdirSync(victim), [])
    assert.match(reasons.join('\n'), /launcher-publish-failed/)
  })
}
