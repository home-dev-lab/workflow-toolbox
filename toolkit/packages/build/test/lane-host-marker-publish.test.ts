import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

// @ts-expect-error ESM runtime module
import { ensureLaneHostDir, laneHostDir } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'

// The marker publication goes through an injected write/link/rename seam, so a test can cut a write
// short, let a concurrent writer publish first, or have the OS refuse a rename at an exact step.
type Step = (...args: unknown[]) => unknown
function markerFs(overrides: { writeFileSync?: Step, linkSync?: Step, renameSync?: Step }) {
  return { writeFileSync: fs.writeFileSync, linkSync: fs.linkSync, renameSync: fs.renameSync, ...overrides }
}

const roots: string[] = []
const previous = process.env.WT_LANE_HOST_STATE
afterEach(() => {
  if (previous === undefined) delete process.env.WT_LANE_HOST_STATE; else process.env.WT_LANE_HOST_STATE = previous
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture() {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lane-marker-publish-')))
  roots.push(root)
  const worktree = join(root, 'worktree')
  mkdirSync(worktree)
  process.env.WT_LANE_HOST_STATE = join(root, 'state')
  return { root, worktree, marker: () => join(laneHostDir(worktree), 'worktree') }
}

it('never leaves a marker without its path when the write is cut short', () => {
  const f = fixture()
  const cutShort = markerFs({ writeFileSync: (file: unknown) => {
    writeFileSync(file as string, '', { flag: 'wx' })
    throw Object.assign(new Error('no space left on device'), { code: 'ENOSPC' })
  } })
  expect(() => ensureLaneHostDir(f.worktree, { markerFs: cutShort })).toThrow('no space left on device')
  expect(existsSync(f.marker())).toBe(false)
})

it('keeps the marker a concurrent writer published first', () => {
  const f = fixture()
  const competitor = join(f.root, 'competitor')
  const first = (step: Step) => (from: unknown, to: unknown) => {
    writeFileSync(to as string, `${competitor}\n`, { flag: 'wx' })
    return step(from, to)
  }
  ensureLaneHostDir(f.worktree, { markerFs: markerFs({ linkSync: first(fs.linkSync as Step), renameSync: first(fs.renameSync as Step) }) })
  expect(readFileSync(f.marker(), 'utf8')).toBe(`${competitor}\n`)
})

it('still launches when the OS refuses to replace an empty marker', () => {
  const f = fixture()
  const host = laneHostDir(f.worktree)
  mkdirSync(host, { recursive: true, mode: 0o700 })
  writeFileSync(f.marker(), '', { mode: 0o600 })
  const refuse = () => { throw Object.assign(new Error('operation not permitted'), { code: 'EPERM' }) }
  expect(ensureLaneHostDir(f.worktree, { markerFs: markerFs({ linkSync: refuse, renameSync: refuse }) })).toBe(host)
  expect(readFileSync(f.marker(), 'utf8')).toBe('')
})
