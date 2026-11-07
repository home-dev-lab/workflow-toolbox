import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { parseSuiteRunOptions as parseBeforePark } from './suite-lock-options-before-park.mjs'

function privateSuite(cli) {
  const root = mkdtempSync(join(tmpdir(), 'wt-park-scenario-'))
  const directory = join(root, 'private')
  mkdirSync(directory, { mode: 0o700 })
  writeFileSync(join(directory, 'key'), 'park-scenario-key-with-at-least-thirty-two-bytes', { mode: 0o600 })
  const env = { ...process.env }
  for (const name of Object.keys(env)) if (/^WT_SUITE_(?:LOCK(?:_|$)|LEASE(?:_|$))/i.test(name)) delete env[name]
  env.WT_SUITE_LOCK_DIR = root
  const flags = ['--park-dir', directory, '--park-s', '60', '--park-owner-pid', String(process.pid)]
  const run = (args = flags, script = 'process.exit(0)') => spawnSync(process.execPath, [cli, 'run', ...args, '--', process.execPath, '-e', script], { env, encoding: 'utf8', timeout: 10_000 })
  return { root, directory, flags, run, env }
}

export function assertParkRequestFreshness(cli) {
  const suite = privateSuite(cli)
  try {
    const first = suite.run(suite.flags, 'require("fs").writeFileSync(process.env.WT_SUITE_LOCK_PARK_REQUEST,"machine lock busy");process.exit(17)')
    assert.equal(first.status, 17, 'the scenario first parks a real CLI ticket')
    const named = JSON.parse(readFileSync(join(suite.directory, 'parked.json'), 'utf8'))
    writeFileSync(join(suite.directory, 'request'), 'abandoned request\n')
    assert.equal(suite.run().status, 0)
    assert.equal(readFileSync(join(suite.directory, 'outcome'), 'utf8'), 'not-parked\n', 'a prior attempt request must not park a consumed place')
    assert(!existsSync(join(suite.directory, 'parked.json')), 'the resumed place is consumed')
    assert(!existsSync(join(suite.root, 'queue.d', `${String(named.number).padStart(16, '0')}.parked`)))
  } finally { rmSync(suite.root, { recursive: true, force: true }) }
}

export function assertParkOwnerPidRange(cli) {
  const suite = privateSuite(cli)
  try {
    const flags = [...suite.flags]
    flags[flags.indexOf('--park-owner-pid') + 1] = String(Number.MAX_SAFE_INTEGER)
    const result = suite.run(flags)
    assert.equal(result.status, 2, 'park owner must be a live pid within the supported range')
    assert.match(result.stderr, /must be a live pid/)
    assert(!existsSync(join(suite.root, 'lock.d')))
  } finally { rmSync(suite.root, { recursive: true, force: true }) }
}

function changedClassResume(cli) {
  const suite = privateSuite(cli)
  try {
    const first = suite.run([...suite.flags, '--priority', 'P2'], 'require("fs").writeFileSync(process.env.WT_SUITE_LOCK_PARK_REQUEST,"class probe");process.exit(17)')
    assert.equal(first.status, 17)
    suite.env.WT_SUITE_LOCK_LIGHT_HOLD_S = '0'
    const readHolder = `process.stdout.write(require('fs').readFileSync(${JSON.stringify(join(suite.root, 'lock.d', 'holder.json'))},'utf8'))`
    const resumed = suite.run([...suite.flags, '--priority', 'P0', '--light'], readHolder)
    assert.equal(resumed.status, 0)
    const holder = JSON.parse(resumed.stdout)
    assert.equal(holder.level, 2, 'resumption keeps its saved declared level')
    assert.notEqual(holder.light, true, 'resumption keeps its saved exclusive class')
    return { ...suite, holder, resumed }
  } catch (error) { rmSync(suite.root, { recursive: true, force: true }); throw error }
}

export function assertParkResumedJournal(cli) {
  const suite = changedClassResume(cli)
  try {
    const journal = spawnSync(process.execPath, [cli, 'journal', '--json'], { env: suite.env, encoding: 'utf8' })
    assert.equal(journal.status, 0)
    const entry = JSON.parse(journal.stdout).tickets.find((ticket) => ticket.leaseId === suite.holder.leaseId)
    assert.equal(entry.priority, 'P2', 'a resumed journal must describe its saved priority')
    assert.equal(entry.kind, 'exclusive', 'a resumed journal must describe its saved class')
    assert.equal(entry.light, false)
  } finally { rmSync(suite.root, { recursive: true, force: true }) }
}

export function assertParkResumedWarning(cli) {
  const suite = changedClassResume(cli)
  try {
    assert(!suite.resumed.stderr.includes('light lease past its class'), 'a resumed exclusive lease must not get a requested-light warning')
  } finally { rmSync(suite.root, { recursive: true, force: true }) }
}

export async function assertParkClaimFailureCleanup(cli) {
  const suite = privateSuite(cli)
  try {
    const first = suite.run(suite.flags, 'require("fs").writeFileSync(process.env.WT_SUITE_LOCK_PARK_REQUEST,"claim probe");process.exit(17)')
    assert.equal(first.status, 17)
    const { parseParkOptions, resumeParkedTicket } = await import(pathToFileURL(join(dirname(cli), 'lib/suite-lock-park.mjs')).href)
    const context = parseParkOptions([...suite.flags], suite.env)
    const named = JSON.parse(readFileSync(join(suite.directory, 'parked.json'), 'utf8'))
    const base = join(suite.root, 'queue.d', String(named.number).padStart(16, '0'))
    const original = JSON.parse(readFileSync(base + '.parked', 'utf8'))
    const record = { ...original.record, pid: process.pid, startTime: context.owner.startTime, pidNamespace: context.owner.pidNamespace, leaseId: 'failed-resume-probe' }
    assert.throws(() => resumeParkedTicket(join(suite.root, 'queue.d'), record, context, Date.now(), () => false, {
      afterClaim: () => { throw Object.assign(new Error('claim publication interrupted'), { code: 'EPERM' }) },
    }), /claim publication interrupted/)
    assert(!existsSync(base + '.json'), 'a failed resume must remove its own published JSON')
    assert.equal(JSON.parse(readFileSync(base + '.parked', 'utf8')).nonce, named.nonce)
  } finally { rmSync(suite.root, { recursive: true, force: true }) }
}

function legacySeconds(trace) {
  return function (flags, name, fallback) {
    trace.push(['seconds', name, fallback, [...flags], this === undefined])
    const index = flags.indexOf(name)
    if (index < 0) return fallback
    const value = Number(flags[index + 1])
    if (!Number.isFinite(value) || value < 0) throw new Error(`${name} must be a non-negative number of seconds`)
    flags.splice(index, 2)
    return value
  }
}

function legacyPriority(trace) {
  return function (flags) {
    trace.push(['priority', [...flags], this === undefined])
    const index = flags.indexOf('--priority')
    if (index < 0) return undefined
    const value = flags[index + 1]
    if (!['release', 'P0', 'P1', 'P2'].includes(value)) throw new Error('invalid priority')
    flags.splice(index, 2)
    return value
  }
}

function legacyDependencies(trace, scenario, sentinel) {
  const dependencies = {
    parseSeconds: legacySeconds(trace), parsePriority: legacyPriority(trace), defaultStaleS: 11,
    waitSeconds() { trace.push(['wait', this === undefined]); return 7 },
    get env() {
      trace.push(['environment', this === dependencies])
      if (scenario.envThrows) throw sentinel
      return { WT_SUITE_LOCK_STATIC_LANE: scenario.staticEnabled ?? '1' }
    },
  }
  return dependencies
}

function legacyObservation(parse, scenario, sentinel) {
  const trace = []
  const argumentsCopy = [...scenario.args]
  const dependencies = legacyDependencies(trace, scenario, sentinel)
  try { return { value: parse(argumentsCopy, dependencies), argumentsCopy, trace } } catch (error) {
    return { error: { name: error.name, message: error.message, code: error.code, sameInjected: error === sentinel }, argumentsCopy, trace }
  }
}

export async function assertParkLegacyOptionsParity(cli) {
  const { parseSuiteRunOptions } = await import(pathToFileURL(join(dirname(cli), 'lib/suite-lock-cli-options.mjs')).href)
  const cases = [
    { args: ['--', 'node', 'probe.mjs'] },
    { args: ['--', 'pnpm', 'typecheck'] },
    { args: ['--', 'pnpm', 'typecheck'], staticEnabled: '0' },
    { args: ['--static', '--', 'node', 'probe.mjs'], envThrows: true },
    { args: ['--light', '--', 'node', 'probe.mjs'] },
    { args: ['--priority', 'P0', '--', 'node', 'probe.mjs'] },
    { args: ['--priority', 'release', '--', 'pnpm', 'test'], envThrows: true },
    { args: ['--priority', 'release', '--light', '--', 'node'], envThrows: true },
    { args: ['--wait-s', '2.5', '--stale-s', '4', '--', 'node'] },
    { args: ['--wait-s', 'bad', '--', 'node'], envThrows: true },
    { args: ['--oops', '--', 'node'] },
    { args: [], envThrows: true },
    { args: ['--'], envThrows: true },
    { args: ['--priority', 'bad', '--', 'node'] },
    { args: ['--static', '--oops', '--', 'node'], envThrows: true },
    { args: ['--light', '--static', '--', 'pnpm', 'quality'], envThrows: true },
    { args: ['--', 'node', 'probe.mjs'], envThrows: true },
  ]
  for (const [index, scenario] of cases.entries()) {
    const sentinel = new Error('injected environment read')
    const expected = legacyObservation(parseBeforePark, scenario, sentinel)
    const actual = legacyObservation(parseSuiteRunOptions, scenario, sentinel)
    assert.deepEqual(actual, expected, `legacy options must match base case ${index + 1}`)
  }
  return cases.length
}
