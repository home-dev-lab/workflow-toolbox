import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { test } from 'node:test'
import { laneWorkerEnv } from '../../../../plugin/bin/wt-lane.mjs'
import { routeDelegateWake } from '../../../../plugin/bin/lib/delegate-wake.mjs'
import { fixture, moduleUrl, routing } from './helpers/launcher-fixtures.mjs'

function parse(f, flags, env = {}) {
  const cli = moduleUrl('wt-lane.mjs')
  const body = `const m=await import(${JSON.stringify(`${cli}?parse-test`)});console.log(JSON.stringify(m.parse(process.argv.slice(1))));`
  const result = spawnSync(process.execPath, ['--input-type=module', '-e', body, '--',
    '--dir', f.root, '--model', 'test/model', '--brief', 'brief.md', ...flags], { env: { ...process.env, ...env }, encoding: 'utf8' })
  assert.equal(result.status, 0, result.stderr)
  return JSON.parse(result.stdout)
}

test('explicit launcher identity wins over its environment fallback', (t) => {
  const f = fixture(t), result = parse(f, ['--launcher-agent', 'Agent_123-x'], { WT_LAUNCHER_AGENT: 'fallback' })
  assert.equal(result.launcherAgentId, 'Agent_123-x')
  assert.equal(laneWorkerEnv({}, 'P2', result.launcherAgentId).WT_LAUNCHER_AGENT, 'Agent_123-x')
})

test('environment fallback attributes a lane to its delegate', (t) => {
  const f = fixture(t)
  assert.equal(parse(f, [], { WT_LAUNCHER_AGENT: 'delegate' }).launcherAgentId, 'delegate')
})

for (const id of ['../bad', 'bad id', 'bad\nline']) {
  test(`unsafe launcher ${JSON.stringify(id)} is rejected before spawning`, (t) => {
    const f = fixture(t)
    assert.match(parse(f, ['--launcher-agent', id]).error, /launcher-agent/)
  })
}

test('relaunch flags preserve the original launcher recipient', (t) => {
  const f = fixture(t), flags = routing.launcherRestartFlag({ launcherAgentId: 'Restart_123' }, (id) => id).trim().split(/\s+/)
  assert.equal(parse(f, flags).launcherAgentId, 'Restart_123')
  assert.equal(routing.launcherRestartFlag({}, (id) => id), '')
})

test('transcript recovery WAKE always reaches main', (t) => {
  const f = fixture(t), item = { kind: 'WAKE', target: 'delegate', key: 'wake:test', line: 'WAKE: delegate background task finished' }
  assert.equal(routeDelegateWake(item, { ...f.options, sessionId: 'session' }), item.line)
})

test('session supervision keeps the main notice callback', () => {
  const notice = () => {}, record = { owner: 'session', ownerSessionId: 'session', launcherAgentId: 'delegate' }
  assert.equal(routing.sessionLauncherNotice(record, () => 'session', notice), notice)
  assert.equal(routing.sessionLauncherNotice(record, () => 'foreign', notice), null)
})
