import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
// @ts-expect-error runtime .mjs helper
import { pidAlive } from '../../../../plugin/bin/lib/artifact-server.mjs'
// @ts-expect-error runtime .mjs helper
import { pilotAdmission } from '../../../../plugin/bin/lib/pilot-admission.mjs'
// @ts-expect-error runtime .mjs helper
import { laneHostDir } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'

function unknownOwner() {
  return vi.spyOn(process, 'kill').mockImplementation((pid) => {
    if (pid === 42) throw Object.assign(new Error('unreadable liveness'), { code: 'EIO' })
    return true
  })
}

  it('retains artifact-server owners whose liveness cannot be measured', () => {
    const kill = unknownOwner()
    try { expect(pidAlive(42), 'unknown artifact PID is retained').toBe(true) } finally { kill.mockRestore() }
  })

  it('retains the admission queue lock while its owner liveness is unknown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-admission-unknown-lock-'))
    const worktree = join(root, 'worktree'); const queue = join(root, 'queue'); const lock = join(queue, 'lock.d')
    mkdirSync(worktree); mkdirSync(lock, { recursive: true })
    writeFileSync(join(lock, 'holder.json'), JSON.stringify({ pid: 42 }))
    const kill = unknownOwner(); let waited = false
    try {
      const lease = await pilotAdmission.awaitPilotAdmission({
        root: queue, worktree, card: 'fixture', maxActive: 1,
        measureLoad: () => ({ available: true, load: 0, cores: 4 }),
        sleep: async () => { waited = true; expect(existsSync(lock), 'unknown owner lock retained').toBe(true); rmSync(lock, { recursive: true }) },
      })
      expect(waited, 'waited for unknown queue owner').toBe(true)
      await pilotAdmission.finishPilotAdmission(lease)
    } finally { kill.mockRestore(); rmSync(laneHostDir(worktree), { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }) }
  })

  it('retains an active admission record while its owner liveness is unknown', async () => {
    const root = mkdtempSync(join(tmpdir(), 'wt-admission-unknown-record-'))
    const worktree = join(root, 'worktree'); const queue = join(root, 'queue'); const entries = join(queue, 'entries')
    mkdirSync(worktree); mkdirSync(entries, { recursive: true })
    const blocker = join(entries, 'active.json')
    writeFileSync(blocker, JSON.stringify({ id: 'active', pid: 42, state: 'active', enqueuedAt: 1 }))
    const kill = unknownOwner(); let waited = false
    try {
      const lease = await pilotAdmission.awaitPilotAdmission({
        root: queue, worktree, card: 'fixture', maxActive: 1,
        measureLoad: () => ({ available: true, load: 0, cores: 4 }),
        sleep: async () => { waited = true; expect(JSON.parse(readFileSync(blocker, 'utf8')).pid).toBe(42); rmSync(blocker) },
      })
      expect(waited, 'unknown active owner retains its slot').toBe(true)
      await pilotAdmission.finishPilotAdmission(lease)
    } finally { kill.mockRestore(); rmSync(laneHostDir(worktree), { recursive: true, force: true }); rmSync(root, { recursive: true, force: true }) }
  })
