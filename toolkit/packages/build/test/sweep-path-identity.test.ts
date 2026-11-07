import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, expect, it, vi } from 'vitest'

const pluginUrl = process.env.WT_SWEEP_TEST_PLUGIN_ROOT
  ? pathToFileURL(`${process.env.WT_SWEEP_TEST_PLUGIN_ROOT}/`).href
  : new URL('../../../../plugin/', import.meta.url).href
const url = (name: string) => new URL(`bin/lib/${name}.mjs`, pluginUrl).href
const native = vi.fn(realpathSync.native)
vi.doMock(url('host/worktree-sweep-io'), async importOriginal => ({
  ...await importOriginal<Record<string, unknown>>(),
  realpathSync: Object.assign(vi.fn(realpathSync), { native }),
}))
const module = await import(/* @vite-ignore */ url('host/sweep-path-identity')).catch(() => null)
const paths = await import(/* @vite-ignore */ url('worktree-sweep/paths'))
const reporting = await import(/* @vite-ignore */ url('worktree-sweep/report'))
const roots: string[] = []
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); vi.clearAllMocks() })
function setup() {
  const project = mkdtempSync(path.join(tmpdir(), 'sweep-identity-')); roots.push(project)
  return { project, source: path.join(project, '.claude', 'worktrees') }
}
function identity(options = {}) {
  expect(module, 'shared sweep path identity adapter must ship').not.toBeNull()
  return module!.sweepPathIdentity(options)
}
const missing = () => { throw Object.assign(new Error('missing'), { code: 'ENOENT' }) }
// The adapter folds case on hosts whose default file system ignores it: Windows and macOS.
const hostKey = (value: string) => process.platform === 'win32' || process.platform === 'darwin' ? value.toLowerCase() : value

it.skipIf(process.platform === 'win32')('retains a POSIX leaf whose final character is a backslash', () => {
  expect(identity({ platform: 'linux', realpath: missing }).key('/tree/leaf\\')).toBe('/tree/leaf\\')
})

it('expands short parent names, retains missing tails, and caches each parent', () => {
  const realpath = vi.fn((file: string) => file.replace(/FIXTU~1/i, 'fixture'))
  const id = identity({ platform: 'win32', realpath })
  expect(id.key('C:\\Temp\\FIXTU~1\\project\\x')).toBe(id.key('c:/Temp/fixture/project/x'))
  id.key('C:\\Temp\\FIXTU~1\\project\\y')
  expect(realpath.mock.calls.filter(([file]) => file === 'C:\\Temp\\FIXTU~1\\project')).toHaveLength(1)
  const nearest = identity({ platform: 'win32', realpath: (file: string) => /project/i.test(file) ? missing() : file.replace('FIXTU~1', 'fixture') })
  expect(nearest.key('C:\\Temp\\FIXTU~1\\project\\missing\\leaf')).toBe('c:\\temp\\fixture\\project\\missing\\leaf')
})

it.skipIf(process.platform === 'win32')('never follows a leaf, including a symlink or a missing registration', () => {
  const realpath = vi.fn((file: string) => file === '/parent/link' ? '/elsewhere' : file)
  const id = identity({ platform: 'linux', realpath })
  expect(id.key('/parent/link')).toBe('/parent/link')
  expect(id.key('/parent/missing')).toBe('/parent/missing')
  expect(realpath.mock.calls).toEqual([['/parent']])
})

it('uses native realpath from the IO facade on parents by default', () => {
  const { project } = setup(); const parent = path.join(project, 'parent'); mkdirSync(parent)
  const expected = path.join(realpathSync.native(parent), 'missing')
  expect(identity().key(path.join(parent, 'missing'))).toBe(hostKey(expected))
  expect(native).toHaveBeenCalledWith(parent)
})

it('keeps a real leaf symlink at its location', () => {
  const { project } = setup(); const target = path.join(project, 'target'); mkdirSync(target)
  const leaf = path.join(project, 'link'); symlinkSync(target, leaf, 'junction')
  const expected = path.join(realpathSync.native(project), 'link')
  expect(identity().key(leaf)).toBe(hostKey(expected))
})

it.skipIf(process.platform === 'win32')('folds Darwin aliases and case, preserves Linux case, and respects separator boundaries', () => {
  const mac = identity({ platform: 'darwin', realpath: missing })
  expect(mac.equals('/var/Tree/x', '/private/var/tree/x')).toBe(true)
  expect(mac.contains('/var/Tree', '/private/var/tree/x')).toBe(true)
  expect(mac.contains('/var/Tree', '/private/var/trees/x')).toBe(false)
  expect(identity({ platform: 'linux', realpath: missing }).equals('/Tree/x', '/tree/x')).toBe(false)
  expect(mac.fold('/')).toBe('/')
})

it('falls back only for filesystem errors and propagates programmer errors', () => {
  const expected = path.resolve('missing', 'x')
  expect(identity({ realpath: missing }).key(expected)).toBe(hostKey(expected))
  expect(() => identity({ realpath: () => { throw new TypeError('bad adapter') } }).key('/missing/x')).toThrow('bad adapter')
})

it.skipIf(process.platform === 'win32')('does not call the host realpath on Windows-flavour paths', () => {
  expect(identity({ platform: 'win32' }).key('C:\\Temp\\tree')).toBe('c:\\temp\\tree')
  expect(native).not.toHaveBeenCalled()
})

const notARepository = { status: 128, stdout: '', stderr: 'fatal: not a git repository (or any of the parent directories): .git\n' }

it('a non-git project has a measured outside count when Git reports no repository', () => {
  const { project, source } = setup(); const gitRun = vi.fn(() => notARepository)
  expect(paths.outsideSweep(project, source, { gitRun })).toMatchObject({ count: 0, complete: true, reason: null })
  expect(gitRun).toHaveBeenCalledTimes(1)
  expect(gitRun, 'the repository check must not depend on the user locale').toHaveBeenCalledWith(
    'git', expect.any(Array), expect.objectContaining({ env: expect.objectContaining({ LC_ALL: 'C' }) }),
  )
})

it('recognizes Git discovery stopping at a filesystem boundary as explicit non-repository evidence', () => {
  const { project, source } = setup()
  const stderr = 'fatal: not a git repository (or any parent up to mount point /)\nStopping at filesystem boundary (GIT_DISCOVERY_ACROSS_FILESYSTEM not set).\n'
  expect(paths.outsideSweep(project, source, { gitRun: () => ({ status: 128, stdout: '', stderr }) }))
    .toMatchObject({ count: 0, complete: true, reason: null })
})

it('a project inside an enclosing repository counts that registry without a local .git', () => {
  const { project, source } = setup(); const elsewhere = path.join(path.dirname(project), 'enclosing-worktree')
  const gitRun = vi.fn(() => ({ status: 0, stdout: `worktree ${elsewhere}\0\0` }))
  expect(paths.outsideSweep(project, source, { gitRun })).toMatchObject({ count: 1, complete: true, paths: [elsewhere] })
})

it.each([
  { status: 1, stdout: '', stderr: 'fatal: unable to read\n' },
  { status: null, stdout: '', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
  { ...notARepository, error: new Error('failed') },
  { status: 0, stdout: '' },
  { status: 128, stdout: '', stderr: 'fatal: permission denied\n' },
])('a project without a local .git whose registry read fails is unknown (%j)', result => {
  const { project, source } = setup()
  expect(paths.outsideSweep(project, source, { gitRun: () => result })).toMatchObject({
    count: null, complete: false, reason: 'worktree-registry-unavailable',
  })
})

it('only the exact Git index lock name is excluded, even where names fold', () => {
  const darwin = identity({ platform: 'darwin', realpath: (value: string) => value })
  const file = (name: string) => ({ isFile: () => true, name })
  expect(paths.isIndexLock('/repo/.git/INDEX.lock', file('INDEX.lock'), '/repo/.git/index.lock', darwin)).toBe(false)
  expect(paths.isIndexLock('/repo/.git/index.lock', file('index.lock'), '/repo/.git/index.lock', darwin)).toBe(true)
})

it.each([
  { result: notARepository, unknown: false, outside: [] },
  { result: { status: 1, stdout: '' }, unknown: true, outside: [] },
  { result: { status: 0, stdout: `worktree ${path.resolve('elsewhere')}\0\0` }, unknown: false, outside: [path.resolve('elsewhere')] },
])('source boundary discovers the project registry without a local .git (%j)', ({ result, unknown, outside }) => {
  const { project, source } = setup(); mkdirSync(source, { recursive: true })
  const gitRun = vi.fn(() => result)
  expect(paths.sourceBoundary(project, { mounts: [], gitRun }).registry).toMatchObject({ unknown, outside })
  expect(gitRun).toHaveBeenCalledTimes(1)
})

it.each([
  { status: 1, stdout: '' },
  { status: null, stdout: '', error: Object.assign(new Error('timeout'), { code: 'ETIMEDOUT' }) },
  { status: 0, stdout: '', error: new Error('failed') },
])('an existing registry that fails enumeration is unknown (%j)', result => {
  const { project, source } = setup(); mkdirSync(path.join(project, '.git'))
  expect(paths.outsideSweep(project, source, { gitRun: () => result })).toMatchObject({
    count: null, complete: false, reason: 'worktree-registry-unavailable',
  })
})

it('reuses supplied registry evidence, including unknown status and seen paths', () => {
  const { project, source } = setup(); const gitRun = vi.fn()
  const registry = { unknown: true, outside: [path.join(project, 'outside')] }
  expect(paths.outsideSweep(project, source, { registry, gitRun })).toMatchObject({
    count: null, complete: false, reason: 'worktree-registry-unavailable', paths: registry.outside,
  })
  expect(gitRun).not.toHaveBeenCalled()
})

it('deduplicates outside registrations by physical Windows identity', () => {
  const { project, source } = setup()
  const registry = { unknown: false, outside: ['C:\\Other\\tree', 'c:/other/tree'] }
  expect(paths.outsideSweep(project, source, { platform: 'win32', registry })).toMatchObject({ count: 1, complete: true })
})

it('renders unknown outside evidence but accepts measured legacy reports', () => {
  const report = { project: 'fixture', summary: { entries: 0, counts: {}, nonDumpable: 0, foreignUnreadable: 0, mismatchExcluded: 0 },
    outsideSweep: { count: null, complete: false, reason: 'worktree-registry-unavailable' } }
  expect(reporting.summaryLine(report)).toContain('outside the sweep unknown (worktree-registry-unavailable)')
  expect(reporting.summaryLine({ ...report, outsideSweep: { count: 2 } })).toContain('2 outside the sweep')
})
