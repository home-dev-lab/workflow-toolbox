import * as fs from 'node:fs'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'

// @ts-expect-error ESM runtime module
import { ensureLaneHostDir, laneHostDir, laneWritablePath } from '../../../../plugin/bin/lib/host/lane-host-dir.mjs'

// The marker publication goes through an injected write/link/rename seam, so a test can cut a write
// short, let a concurrent writer publish first, or have the OS refuse a step, at an exact point.
type Step = (...args: unknown[]) => unknown
function markerFs(overrides: { writeFileSync?: Step, linkSync?: Step }) {
  return { writeFileSync: fs.writeFileSync, linkSync: fs.linkSync, openSync: fs.openSync, closeSync: fs.closeSync, unlinkSync: fs.unlinkSync, ...overrides }
}
const failure = (code: string) => Object.assign(new Error(code), { code })

const roots: string[] = []
const previous = process.env.WT_LANE_HOST_STATE
afterEach(() => {
  if (previous === undefined) delete process.env.WT_LANE_HOST_STATE; else process.env.WT_LANE_HOST_STATE = previous
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(name = 'worktree') {
  const root = realpathSync(mkdtempSync(join(tmpdir(), 'lane-marker-publish-')))
  roots.push(root)
  const worktree = join(root, name)
  mkdirSync(worktree)
  process.env.WT_LANE_HOST_STATE = join(root, 'state')
  const host = () => laneHostDir(worktree)
  return { root, worktree, host, marker: () => join(host(), 'worktree'), staged: () => readdirSync(host()).filter((entry) => entry !== 'worktree') }
}

function withEmptyMarker(f: ReturnType<typeof fixture>) {
  mkdirSync(f.host(), { recursive: true, mode: 0o700 })
  writeFileSync(f.marker(), '', { mode: 0o600 })
}

it('never leaves a marker without its path, nor a staging file, when the write is cut short', () => {
  const f = fixture()
  const cutShort = markerFs({ writeFileSync: (file: unknown) => {
    writeFileSync(file as string, '', { flag: 'wx' })
    throw failure('ENOSPC')
  } })
  expect(() => ensureLaneHostDir(f.worktree, { markerFs: cutShort })).toThrow('ENOSPC')
  expect(existsSync(f.marker())).toBe(false)
  expect(f.staged()).toEqual([])
})

it('keeps the marker a concurrent writer published first', () => {
  const f = fixture()
  const competitor = join(f.root, 'competitor')
  const linkSync = (from: unknown, to: unknown) => {
    writeFileSync(to as string, `${competitor}\n`, { flag: 'wx' })
    return fs.linkSync(from as string, to as string)
  }
  ensureLaneHostDir(f.worktree, { markerFs: markerFs({ linkSync }) })
  expect(readFileSync(f.marker(), 'utf8')).toBe(`${competitor}\n`)
})

it('keeps a first writer\'s marker where the file system refuses hard links, whatever the error', () => {
  const f = fixture()
  const competitor = join(f.root, 'competitor')
  const linkSync = (_from: unknown, to: unknown) => {
    writeFileSync(to as string, `${competitor}\n`, { flag: 'wx' })
    throw failure('EISDIR')
  }
  ensureLaneHostDir(f.worktree, { markerFs: markerFs({ linkSync }) })
  expect(readFileSync(f.marker(), 'utf8')).toBe(`${competitor}\n`)
})

it('publishes the marker where the file system refuses hard links', () => {
  const f = fixture()
  ensureLaneHostDir(f.worktree, { markerFs: markerFs({ linkSync: () => { throw failure('EINVAL') } }) })
  expect(readFileSync(f.marker(), 'utf8')).toBe(`${f.worktree}\n`)
  expect(f.staged()).toEqual([])
})

it('removes its own half-written marker when the fallback write fails', () => {
  const f = fixture()
  const writeFileSync = (file: unknown, ...rest: unknown[]) => {
    if (typeof file === 'number') {
      fs.writeSync(file, f.worktree.slice(0, 4))
      throw failure('ENOSPC')
    }
    return (fs.writeFileSync as Step)(file, ...rest)
  }
  const linkSync = () => { throw failure('EPERM') }
  expect(() => ensureLaneHostDir(f.worktree, { markerFs: markerFs({ writeFileSync, linkSync }) })).toThrow('ENOSPC')
  expect(existsSync(f.marker())).toBe(false)
  expect(f.staged()).toEqual([])
})

it('leaves an invalid marker in place, never replacing what sits at the marker path, and still launches', () => {
  const f = fixture()
  withEmptyMarker(f)
  const refuse = () => { throw failure('unexpected publication') }
  expect(ensureLaneHostDir(f.worktree, { markerFs: markerFs({ writeFileSync: refuse, linkSync: refuse }) })).toBe(f.host())
  expect(readFileSync(f.marker(), 'utf8')).toBe('')
})

it.skipIf(process.platform === 'win32')('protects a worktree whose name contains a newline', () => {
  const f = fixture('lane\nworktree')
  ensureLaneHostDir(f.worktree)
  const other = join(f.root, 'other')
  mkdirSync(other)
  expect(laneWritablePath(other, join(f.worktree, 'run.log'))).toBe(true)
})
