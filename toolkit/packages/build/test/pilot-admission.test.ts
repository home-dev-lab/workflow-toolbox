import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

// @ts-expect-error Runtime .mjs helper under plugin/bin/lib/.
const admissionModule = await import('../../../../plugin/bin/lib/pilot-admission.mjs').catch(() => null)

describe('SDK pilot admission queue', () => {
  it('ships the admission queue core', () => {
    expect(admissionModule, 'pilot admission queue core is shipped').not.toBeNull()
  })

  it('admits queued runs in FIFO order, one decision at a time', () => {
    expect(admissionModule).not.toBeNull()
    const decide = admissionModule!.pilotAdmission.admissionDecision
    const records = [
      { id: 'second', state: 'queued', enqueuedAt: 20, pid: 102 },
      { id: 'first', state: 'queued', enqueuedAt: 10, pid: 101 },
    ]

    expect(decide(records, 'second', { load: 1, cores: 4, maxActive: 3 })).toMatchObject({ admit: false, position: 2 })
    expect(decide(records, 'first', { load: 1, cores: 4, maxActive: 3 })).toMatchObject({ admit: true, position: 1 })
  })

  it('requires both spare load and a free concurrency slot', () => {
    expect(admissionModule).not.toBeNull()
    const decide = admissionModule!.pilotAdmission.admissionDecision
    const queued = { id: 'queued', state: 'queued', enqueuedAt: 20, pid: 102 }

    expect(decide([{ id: 'active', state: 'active', enqueuedAt: 10, pid: 101 }, queued], 'queued', { load: 1, cores: 4, maxActive: 1 }))
      .toMatchObject({ admit: false, waiting: { kind: 'slot', active: 1, limit: 1 } })
    expect(decide([queued], 'queued', { load: 4, cores: 4, maxActive: 3 }))
      .toMatchObject({ admit: false, waiting: { kind: 'load', load: 4, cores: 4 } })
    expect(decide([queued], 'queued', { load: 3.99, cores: 4, maxActive: 3 })).toMatchObject({ admit: true })
  })

  it('falls back to the cap alone with a legible platform reason when load is unavailable', () => {
    expect(admissionModule).not.toBeNull()
    const measure = admissionModule!.pilotAdmission.measurePilotLoad
    const windows = measure({ platform: 'win32', availableParallelism: () => 8 })
    expect(windows).toMatchObject({ available: false, cores: 8, reason: 'Windows os.loadavg() reports zeros; using concurrency cap only' })
    expect(measure({ platform: 'linux', availableParallelism: () => { throw new Error('unavailable') } }))
      .toMatchObject({ available: false, cores: null, reason: 'available core count is unreadable; using concurrency cap only' })

    const queued = { id: 'queued', state: 'queued', enqueuedAt: 20, pid: 102 }
    expect(admissionModule!.pilotAdmission.admissionDecision([queued], 'queued', { load: null, cores: 8, maxActive: 3 })).toMatchObject({ admit: true })
  })

  it('persists queued state before admission and removes the shared active lease on finish', async () => {
    expect(admissionModule).not.toBeNull()
    const root = mkdtempSync(join(tmpdir(), 'wt-pilot-admission-'))
    const worktree = join(root, 'worktree')
    mkdirSync(worktree)
    try {
      const lease = await admissionModule!.pilotAdmission.awaitPilotAdmission({
        root: join(root, 'queue'), worktree, card: '1867509524609369334', maxActive: 3,
        measureLoad: () => ({ available: true, load: 1, cores: 8, source: 'fixture' }),
      })
      const statusFile = join(worktree, '.lane', 'admission.json')
      expect(JSON.parse(readFileSync(statusFile, 'utf8'))).toMatchObject({ state: 'active', position: 1, cardId: '1867509524609369334' })
      expect(existsSync(lease.record.file)).toBe(true)

      await admissionModule!.pilotAdmission.finishPilotAdmission(lease)
      expect(existsSync(lease.record.file)).toBe(false)
      expect(JSON.parse(readFileSync(statusFile, 'utf8'))).toMatchObject({ state: 'finished', position: null })
    } finally { rmSync(root, { recursive: true, force: true }) }
  })

  it('logs an unavailable load probe once while polling more than once', async () => {
    expect(admissionModule).not.toBeNull()
    const root = mkdtempSync(join(tmpdir(), 'wt-pilot-admission-fallback-'))
    const queue = join(root, 'queue')
    const entries = join(queue, 'entries')
    const worktree = join(root, 'worktree')
    mkdirSync(entries, { recursive: true }); mkdirSync(worktree)
    const blocker = join(entries, 'blocker.json')
    writeFileSync(blocker, JSON.stringify({ id: 'blocker', cardId: '1', pid: process.pid, state: 'queued', enqueuedAt: 1 }))
    const logged: string[] = []
    try {
      const lease = await admissionModule!.pilotAdmission.awaitPilotAdmission({
        root: queue, worktree, card: '2', maxActive: 3, now: () => 2,
        measureLoad: () => ({ available: false, load: null, cores: 8, reason: 'fixture unavailable' }),
        log: (line: string) => logged.push(line), sleep: async () => rmSync(blocker, { force: true }),
      })
      expect(logged).toEqual(['admission load unavailable: fixture unavailable'])
      await admissionModule!.pilotAdmission.finishPilotAdmission(lease)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
