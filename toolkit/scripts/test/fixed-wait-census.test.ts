import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { approvalEntry, checkFixedWaits, scanFixedWaits, scanSource, validateAllowList } from '../fixed-wait-census.mjs'

const roots: string[] = []

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

// A synchronous parse of every test file in the repository: seconds when idle, far longer beside a full
// suite (the same bound the ambient-state census uses, for the same measured reason).
const WHOLE_TREE_SCAN_TIMEOUT_MS = 120_000

function signals(source: string) {
  return scanSource('packages/example/test/control.test.ts', source).map((finding) => `${finding.signal} ${finding.detail}`)
}

describe('fixed-wait census', () => {
  it('flags every shape of a pause measured in milliseconds', () => {
    expect(signals(`
import { setTimeout as delay } from 'node:timers/promises'
const SETTLE_MS = 2 * 100
await new Promise((resolve) => setTimeout(resolve, SETTLE_MS))
await delay(300)
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 250)
await sleep(50)
`)).toEqual([
      'fixed-sleep setTimeout 200 ms',
      'fixed-sleep setTimeout 300 ms',
      'fixed-sleep Atomics.wait 250 ms',
      'fixed-sleep sleep 50 ms',
    ])
  })

  it('flags a short bound on something another process produces, in each form a test writes it', () => {
    expect(signals(`
import { spawnSync } from 'node:child_process'
async function waitForFile(file: string, timeoutMs = 3000) {}
const until = Date.now() + 5_000
await waitFor(() => ready(), 4000)
spawnSync('node', ['x.mjs'], { encoding: 'utf8', timeout: 8000 })
`)).toEqual([
      'short-deadline waitForFile(timeoutMs = 3000 ms)',
      'short-deadline now() + 5000 ms',
      'short-deadline waitFor(…, 4000 ms)',
      'short-deadline spawnSync timeout: 8000 ms',
    ])
  })

  it('resolves the forms a new test plausibly writes: scoped constants, aliases, expressions, option objects', () => {
    expect(signals(`
import { setTimeout as snooze } from 'node:timers/promises'
import { setTimeout as later } from 'node:timers'
import { spawn as start } from 'node:child_process'
it('ready', async () => {
  const ms = 500
  await sleep(ms)
  await snooze(400, undefined, { signal })
  later(resolve, 300)
  await sleep(1000 / 2)
  await delay(600 as number)
  const end = (Date.now()) + 700
  start('node', [], { timeout: 800 })
  const opts = { timeout: 900 }
  start('node', [], opts)
  const timeout = 950
  start('node', [], { timeout })
  await waitFor(() => ready(), { timeout: 450 })
})
async function waitForFile(file: string, budget = 350) {}
`)).toEqual([
      'fixed-sleep sleep 500 ms',
      'fixed-sleep setTimeout 400 ms',
      'fixed-sleep setTimeout 300 ms',
      'fixed-sleep sleep 500 ms',
      'fixed-sleep delay 600 ms',
      'short-deadline now() + 700 ms',
      'short-deadline start timeout: 800 ms',
      'short-deadline start timeout: 900 ms',
      'short-deadline start timeout: 950 ms',
      'short-deadline waitFor({ timeout: 450 ms })',
      'short-deadline waitForFile(budget = 350 ms)',
    ])
  })

  it('reports a pause whose loop only waits for the clock, or never reads it, and the bound of an elapsed-time check', () => {
    expect(signals(`
const deadline = Date.now() + 30_000
while (Date.now() < deadline) {
  await new Promise((r) => setTimeout(r, 500))
}
while (Date.now() < deadline) {
  trigger()
  await sleep(501)
  expect(result()).toBe(true)
  break
}
while (!ready()) {
  if (mode === 'deadline') log(mode)
  await sleep(502)
}
for (const item of items) {
  while (!done(item) && Date.now() < deadline) {
    for (const probe of probes) await sleep(503)
  }
}
const started = Date.now()
while (!ready()) {
  if (Date.now() - started > 504) throw new Error('late')
  await sleep(20)
}
`)).toEqual([
      'fixed-sleep setTimeout 500 ms',
      'fixed-sleep sleep 501 ms',
      'fixed-sleep sleep 502 ms',
      'fixed-sleep sleep 503 ms',
      'short-deadline elapsed bound 504 ms',
    ])
  })

  it('does not read a method named like a sleep, a non-child-process timeout, or a constant a parameter shadows', () => {
    expect(signals(`
const ms = 500
player.pause(500)
database.exec('query', { timeout: 500 })
async function waitForThing(ms = 60_000) {
  return waitFor(ready, ms)
}
`)).toEqual([])
  })

  it('changes the key when the number changes, even when the statement starts on an earlier line', () => {
    const at = (value: number) => scanSource('packages/example/test/k.test.ts', `setTimeout(\n  resolve, ${value}\n)\n`).map((finding) => finding.key)
    expect(at(500)).not.toEqual(at(9000))
  })

  it('stays silent on a generous event wait, the tick of a deadline-bounded poll, a unit input named timeout, and code inside a fixture string', () => {
    expect(signals(`
import { spawnSync } from 'node:child_process'
async function waitForFile(file: string, timeoutMs = 60_000) {}
await waitFor(() => ready(), 30_000)
const until = Date.now() + 45_000
spawnSync('node', ['x.mjs'], { timeout: 120_000 })
await runPilot({ timeout: 2, laneWaitMs: 100 })
const child = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'])
setTimeout(resolve, 0)
const deadline = Date.now() + 30_000
while (!existsSync(file) && Date.now() < deadline) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 50)
while (!done()) {
  if (Date.now() > deadline) throw new Error('late')
  await new Promise((resolve) => setTimeout(resolve, 25))
}
`)).toEqual([])
  })

  it('keeps an approval key stable when unrelated lines move the site, and tells identical statements apart', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-fixed-wait-census-'))
    roots.push(root)
    mkdirSync(join(root, 'packages/example/test'), { recursive: true })
    const file = join(root, 'packages/example/test/moved.test.ts')
    const body = 'await new Promise((r) => setTimeout(r, 50))\nawait new Promise((r) => setTimeout(r, 50))\n'
    writeFileSync(file, body)
    const before = scanFixedWaits(root).map((finding) => finding.key)
    writeFileSync(file, `// one\n// two\n${body}`)
    expect(scanFixedWaits(root).map((finding) => finding.key)).toEqual(before)
    expect(new Set(before).size).toBe(2)
    expect(before[0]).toBe('packages/example/test/moved.test.ts:fixed-sleep:setTimeout 50 ms:await new Promise((r) => setTimeout(r, 50))')
  })

  it('refuses a new fixed wait until it is converted or named, and hands the entry to paste', () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-fixed-wait-census-'))
    roots.push(root)
    mkdirSync(join(root, 'scripts/test'), { recursive: true })
    writeFileSync(join(root, 'scripts/test/new.test.ts'), 'await new Promise((r) => setTimeout(r, 500))\n')
    const unnamed = checkFixedWaits(root, new Map())
    expect(unnamed.unapproved.map((finding) => finding.key)).toEqual(['scripts/test/new.test.ts:fixed-sleep:setTimeout 500 ms:await new Promise((r) => setTimeout(r, 500))'])
    expect(approvalEntry(unnamed.unapproved[0]!)).toContain('"scripts/test/new.test.ts:fixed-sleep:setTimeout 500 ms:await new Promise((r) => setTimeout(r, 500))"')
    const named = checkFixedWaits(root, new Map([[unnamed.unapproved[0]!.key, { class: 'duration-bound', reason: 'proves nothing arrives within the window' }]]))
    expect(named.unapproved).toEqual([])
    expect(named.stale).toEqual([])
  })

  it('refuses an exemption with no class, no reason, or a convertible one with no owning card', () => {
    expect(validateAllowList(new Map<string, { class: string, reason: string, card?: string }>([
      ['a', { class: 'later', reason: 'x' }],
      ['b', { class: 'not-a-wait', reason: ' ' }],
      ['c', { class: 'convertible', reason: 'short cap on a child line' }],
      ['d', { class: 'convertible', reason: 'short cap on a child line', card: '1863398344542389302' }],
    ]))).toEqual([
      'a: class must be one of duration-bound, not-a-wait, convertible',
      'b: reason is required',
      'c: a convertible exemption must name its owning card id',
    ])
  })

  it('requires every fixed wait in the repository to be converted or to carry a named exemption', () => {
    const result = checkFixedWaits()
    expect(result.invalid).toEqual([])
    expect(result.unapproved.map((finding) => `${finding.file}:${finding.line} ${finding.signal}: ${finding.detail}`), 'Wait on the event, or name the exemption in scripts/fixed-wait-allow-list.mjs').toEqual([])
    expect(result.stale, 'Remove stale exemptions').toEqual([])
  }, WHOLE_TREE_SCAN_TIMEOUT_MS)
})
