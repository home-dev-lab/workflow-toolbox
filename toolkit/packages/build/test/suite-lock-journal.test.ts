import { spawn } from 'node:child_process'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
// @ts-expect-error plugin runtime module
import { acquireSuiteLock, releaseSuiteLock } from '../../../../plugin/bin/lib/suite-lock.mjs'

const roots: string[] = []
const scratch = () => { const root = mkdtempSync(join(tmpdir(), 'wt-journal-')); roots.push(root); return root }
const moduleUrl = new URL('../../../../plugin/bin/lib/suite-lock-journal.mjs', import.meta.url).href
const appendUrl = new URL('../../../../plugin/bin/lib/host/suite-lock-journal-append.mjs', import.meta.url).href
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }) })

it('journals request grant release with one leaseId and the command exit', async () => {
  const root = scratch()
  const lease = await acquireSuiteLock({ root, argv: ['pnpm', 'test'], stamp: 1234567890000, now() { return this.stamp } })
  releaseSuiteLock(lease, { exit: 7 })
  const events = readFileSync(join(root, 'journal.jsonl'), 'utf8').trim().split('\n').map((line) => JSON.parse(line))
  expect(events.map((event) => event.event)).toEqual(['request', 'grant', 'release'])
  expect(events.every((event) => event.leaseId === lease.holder.leaseId)).toBe(true)
  expect(events[0].ts).toBe('2009-02-13T23:31:30.000Z')
  expect(events[2].exit).toBe(7)
})

it('counts unfinished grants as censored and skips torn lines at full precision', async () => {
  const { readSuiteLockJournal } = await import(moduleUrl)
  const root = scratch()
  const event = (leaseId: string, event: string, ts: string) => JSON.stringify({ leaseId, event, ts, kind: 'light', pid: process.pid })
  writeFileSync(join(root, 'journal.1.jsonl'), event('done', 'request', '2026-01-01T00:00:00.000Z') + '\n')
  writeFileSync(join(root, 'journal.jsonl'), [event('done', 'grant', '2026-01-01T00:00:00.123Z'), event('done', 'release', '2026-01-01T00:00:00.456Z'), event('crash', 'grant', '2026-01-01T00:00:01.000Z'), '{torn'].join('\n'))
  const result = readSuiteLockJournal(root)
  expect(result.censored).toBe(1)
  expect(result.grantsWithoutRequest).toBe(1)
  expect(result.invalidLines).toBe(1)
  expect(result.summary.light.hold.p50).toBe(0.333)
  expect(result.summary.light.wait.p90).toBe(0.123)
})

it('until censors a hold whose release is outside the requested window', async () => {
  const { readSuiteLockJournal } = await import(moduleUrl)
  const root = scratch()
  const events = ['request', 'grant', 'release'].map((event, index) => ({ event, leaseId: 'window', kind: 'light', ts: new Date(index * 1000).toISOString() }))
  writeFileSync(join(root, 'journal.jsonl'), events.map((event) => JSON.stringify(event)).join('\n'))
  const result = readSuiteLockJournal(root, { until: new Date(1500).toISOString() })
  expect(result.censored).toBe(1)
  expect(result.summary.light.hold.count).toBe(0)
})

it('journal classification cannot fail acquisition on a non-string display argument', async () => {
  const root = scratch()
  const lease = await acquireSuiteLock({ root, argv: [null] })
  releaseSuiteLock(lease)
  expect(readFileSync(join(root, 'journal.jsonl'), 'utf8')).toContain('"cmd":"other"')
  const unprintable = await acquireSuiteLock({ root, argv: [Object.create(null)] })
  releaseSuiteLock(unprintable)
})

it('journals a timeout without inventing a grant or a completed hold', async () => {
  const { readSuiteLockJournal } = await import(moduleUrl)
  const root = scratch()
  const lease = await acquireSuiteLock({ root })
  try { await expect(acquireSuiteLock({ root, waitS: 0 })).rejects.toThrow('timed out') } finally { releaseSuiteLock(lease) }
  const result = readSuiteLockJournal(root)
  expect(result.tickets).toHaveLength(2)
  expect(result.tickets.filter((ticket: { timeout?: object }) => ticket.timeout)).toHaveLength(1)
  expect(result.censored).toBe(0)
  expect(result.grantsWithoutRequest).toBe(0)
})

it('censors crashed exclusive and static holders and reclaims their claims', async () => {
  const { readSuiteLockJournal } = await import(moduleUrl)
  const lockUrl = new URL('../../../../plugin/bin/lib/suite-lock.mjs', import.meta.url).href
  for (const staticRun of [false, true]) {
    const root = scratch()
    const source = `import {acquireSuiteLock} from ${JSON.stringify(lockUrl)};await acquireSuiteLock({root:${JSON.stringify(root)},static:${staticRun},env:{WT_SUITE_LOCK_STATIC_LANE:'1'}});process.stdout.write('granted');setInterval(()=>{},1000);`
    const child = spawn(process.execPath, ['--input-type=module', '-e', source])
    const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()))
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once('data', () => resolve()); child.once('error', reject) })
      child.kill('SIGKILL')
      await exited
      const result = readSuiteLockJournal(root)
      expect(result.censored).toBe(1)
      expect(result.tickets[0].holdS).toBeNull()
      const recovered = await acquireSuiteLock({ root, static: staticRun, env: { WT_SUITE_LOCK_STATIC_LANE: '1' }, waitS: 1 })
      releaseSuiteLock(recovered)
      expect(readSuiteLockJournal(root).grantsWithoutRequest).toBe(0)
    } finally { child.kill('SIGKILL'); await exited }
  }
})

it('concurrent appenders retain complete bounded JSON lines with O_APPEND', async () => {
  const root = scratch()
  const seed = JSON.stringify({ event: 'request', leaseId: 'seed', argv: 'x'.repeat(900) }) + '\n'
  writeFileSync(join(root, 'journal.jsonl'), seed.repeat(3300))
  const source = `import { appendSuiteLockJournal } from ${JSON.stringify(appendUrl)}; for(let i=0;i<300;i++) appendSuiteLockJournal(${JSON.stringify(root)}, {event:'request',leaseId:process.pid+'-'+i,argv:'x'.repeat(900)});`
  await Promise.all(Array.from({ length: 6 }, () => new Promise<void>((resolve, reject) => {
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'pipe' })
    child.once('error', reject)
    child.once('exit', (code) => code === 0 ? resolve() : reject(new Error(`appender exit ${code}`)))
  })))
  const lines = ['journal.1.jsonl', 'journal.jsonl'].flatMap((name) => readFileSync(join(root, name), 'utf8').trim().split('\n'))
  const events = lines.map((line) => JSON.parse(line)).filter((event) => event.leaseId !== 'seed')
  expect(events).toHaveLength(1800)
  expect(new Set(events.map((event) => event.leaseId)).size).toBe(1800)
})

it('rotates at four MiB and keeps telemetry failures non-fatal', async () => {
  const { appendSuiteLockJournal } = await import(appendUrl)
  const root = scratch()
  writeFileSync(join(root, 'journal.jsonl'), 'x'.repeat(4 * 1024 * 1024 + 1))
  appendSuiteLockJournal(root, { event: 'request', leaseId: 'next' })
  expect(readFileSync(join(root, 'journal.1.jsonl'), 'utf8').length).toBe(4 * 1024 * 1024 + 1)
  expect(JSON.parse(readFileSync(join(root, 'journal.jsonl'), 'utf8')).leaseId).toBe('next')
  expect(() => appendSuiteLockJournal(join(root, 'missing'), {})).not.toThrow()
})

it('an in-flight rotation retains a concurrent append without waiting', async () => {
  const { appendSuiteLockJournal } = await import(appendUrl)
  const root = scratch()
  writeFileSync(join(root, 'journal.jsonl'), 'x'.repeat(4 * 1024 * 1024 + 1) + '\n')
  mkdirSync(join(root, 'journal-rotate.d'))
  writeFileSync(join(root, 'journal-rotate.d/holder.json'), JSON.stringify({ pid: process.pid, leaseId: 'rotating' }))
  appendSuiteLockJournal(root, { event: 'request', leaseId: 'retained' })
  expect(readFileSync(join(root, 'journal.jsonl'), 'utf8')).toContain('"leaseId":"retained"')
  rmSync(join(root, 'journal-rotate.d'), { recursive: true })
  appendSuiteLockJournal(root, { event: 'request', leaseId: 'after-rotation' })
  const previous = readFileSync(join(root, 'journal.1.jsonl'), 'utf8')
  expect(previous).toContain('"leaseId":"retained"')
  expect(previous).not.toContain('"leaseId":"after-rotation"')
  expect(JSON.parse(readFileSync(join(root, 'journal.jsonl'), 'utf8')).leaseId).toBe('after-rotation')
})
