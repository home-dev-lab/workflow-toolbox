import { pathToFileURL } from 'node:url'
import { beforeEach, expect, it, vi } from 'vitest'

// A native Windows path module with injected Linux process evidence reproduces
// the report fixture on Windows, without needing a Windows filesystem on CI.
vi.mock('node:path', async importOriginal => {
  const actual = await importOriginal<typeof import('node:path')>()
  return { ...actual.win32, default: actual.win32 }
})
const { win32 } = await import('node:path')
const pluginUrl = process.env.WT_SWEEP_TEST_PLUGIN_ROOT
  ? pathToFileURL(`${process.env.WT_SWEEP_TEST_PLUGIN_ROOT}/`).href
  : new URL('../../../../plugin/', import.meta.url).href
const moduleUrl = (relative: string) => new URL(`bin/lib/${relative}.mjs`, pluginUrl).href
type Node = { file: string; kind: 'directory' | 'file' | 'link'; time: bigint; target: string | undefined }
const nodes = new Map<string, Node>()
const key = (file: string) => win32.resolve(file).toLowerCase()
const project = 'C:\\Temp\\fixture\\project'
const source = win32.join(project, '.claude', 'worktrees')
const clean = win32.join(source, 'clean')
const now = Date.UTC(2035, 0, 1)
let registry = ''
function add(file: string, kind: Node['kind'] = 'directory', time = 0n, target?: string) {
  nodes.set(key(file), { file, kind, time, target })
}
function stat(file: string, options?: { throwIfNoEntry?: boolean }) {
  const node = nodes.get(key(file))
  if (!node && options?.throwIfNoEntry === false) return undefined
  if (!node) throw Object.assign(new Error(`missing ${file}`), { code: 'ENOENT' })
  return { dev: 1n, ino: 1n, mode: 0n, size: 1n, nlink: 1n, mtimeNs: node.time, ctimeNs: node.time,
    isDirectory: () => node.kind === 'directory', isFile: () => node.kind === 'file', isSymbolicLink: () => node.kind === 'link' }
}
function readdir(file: string, options?: { withFileTypes?: boolean }) {
  return [...nodes.values()].filter(node => key(win32.dirname(node.file)) === key(file)).map(node => options?.withFileTypes
    ? { name: win32.basename(node.file), isFile: () => node.kind === 'file' } : win32.basename(node.file))
}
function gitRun(_cmd: string, args: string[]) {
  const dir = args[args.indexOf('-C') + 1]!
  let stdout = ''
  if (args.includes('worktree')) stdout = registry
  if (args.includes('--absolute-git-dir')) stdout = win32.join(dir, '.git').replaceAll('\\', '/').replace(/^C:/, 'c:') + '\n'
  if (args.includes('symbolic-ref')) stdout = 'refs/heads/topic\n'
  if (args.includes('for-each-ref')) stdout = 'refs/remotes/origin/main \n'
  return { status: 0, stdout }
}
// Model an open that follows a dangling Windows reparse point. An occupied
// pathname must be rejected even when O_NOFOLLOW is unavailable.
const open = vi.fn((file: string) => {
  const node = nodes.get(key(file))
  if (node?.kind === 'link') { add(node.target!, 'file'); return 7 }
  if (node) throw Object.assign(new Error('already exists'), { code: 'EEXIST' })
  add(file, 'file')
  return 7
})
const write = vi.fn()
vi.doMock(moduleUrl('host/worktree-sweep-io'), async importOriginal => {
  const actual = await importOriginal<Record<string, unknown>>()
  return { ...actual, existsSync: (file: string) => nodes.has(key(file)), lstatSync: stat, readdirSync: readdir,
    realpathSync: (file: string) => nodes.get(key(file))?.file ?? file, spawnSync: gitRun, sweepPlatform: () => 'win32',
    constants: { ...(actual.constants as Record<string, number>), O_NOFOLLOW: 0 }, openSync: open, writeFileSync: write, closeSync: vi.fn() }
})
vi.doMock(moduleUrl('host/sweep-processes'), () => ({
  hostNamespaceEvidence: () => ({ status: 'known' }), recordedProcessPresence: () => 'absent',
  scanSweepProcesses: () => ({ status: 'known', references: [] }),
}))
vi.doMock(moduleUrl('plugin-options'), () => ({ resolveWorkflowToolboxOption: () => ({ value: 'report' }) }))
const sweep = await import(/* @vite-ignore */ moduleUrl('worktree-sweep/scan'))
const reporting = await import(/* @vite-ignore */ moduleUrl('worktree-sweep/report'))
const paths = await import(/* @vite-ignore */ moduleUrl('worktree-sweep/paths'))
const options = () => ({ project, platform: 'linux', mounts: [], now, gitRun, procfs: {}, hostNamespace: { status: 'known' } })
const snapshot = () => [...nodes.entries()].map(([name, node]) => [name, { ...node }])
beforeEach(() => {
  nodes.clear(); vi.clearAllMocks()
  for (const dir of [project, win32.dirname(source), source, clean, win32.join(clean, '.git')]) add(dir)
  registry = `worktree ${clean.replaceAll('\\', '/')}\0\0`
})

it('Windows index-lock spelling is ignored in both inventory and the second idle observation', () => {
  add(win32.join(clean, '.git', 'index.lock'), 'file', BigInt(now) * 1_000_000n)
  const before = snapshot()
  expect(sweep.scanProject(options()).entries).toMatchObject([{ name: 'clean', reason: 'eligible', verdict: 'ELIGIBLE (report only)' }])
  expect(snapshot()).toEqual(before)
  add(win32.join(clean, 'ignored')); add(win32.join(clean, 'ignored', 'index.lock'), 'file', BigInt(now) * 1_000_000n)
  expect(sweep.scanProject(options()).entries).toMatchObject([{ name: 'clean', reason: 'recent', verdict: 'KEEP' }])
})

it.each(['locked', 'prunable'])('Windows registry case spelling retains %s on the disk-named entry', flag => {
  registry = `worktree ${clean.toUpperCase().replaceAll('\\', '/')}\0${flag} owner lease\0\0`
  const before = snapshot()
  const report = sweep.scanProject(options())
  expect(report.entries.find((entry: { name: string }) => entry.name === 'clean')).toMatchObject({
    verdict: 'KEEP', reason: flag === 'locked' ? 'locked' : 'registered-prunable',
  })
  expect(report.entries).toHaveLength(1)
  expect(snapshot()).toEqual(before)
})

it.each(['locked', 'prunable'])('Windows same-spelling registry retains %s with Linux process evidence', flag => {
  registry = `worktree ${clean.replaceAll('\\', '/')}\0${flag} owner lease\0\0`
  expect(sweep.scanProject(options()).entries).toMatchObject([{
    name: 'clean', verdict: 'KEEP', reason: flag === 'locked' ? 'locked' : 'registered-prunable',
  }])
})

it('Windows registry paths count only the two outside registrations with Linux process evidence', () => {
  const outside = ['C:\\Temp\\fixture\\outside', win32.join(clean, 'nested')]
  registry = [clean, ...outside].map(file => `worktree ${file.replaceAll('\\', '/')}\0\0`).join('')
  const before = snapshot()
  const report = sweep.scanProject(options())
  expect(report.entries.map((entry: { name: string }) => entry.name)).toEqual(['clean'])
  expect(report.outsideSweep.count).toBe(2)
  expect(report.outsideSweep.paths.map(key).sort()).toEqual(outside.map(key).sort())
  expect(snapshot()).toEqual(before)
})

it('Windows inventory alone excludes the case-varied Git lock', () => {
  const lock = win32.join(clean, '.git', 'index.lock')
  add(lock, 'file', BigInt(now) * 1_000_000n)
  const inventory = paths.inventoryTree(clean, { device: 1n, mounts: [], indexLock: lock.toLowerCase(), deadline: Infinity })
  expect(inventory.latestNs).toBe(0n)
  expect(inventory.files).toEqual([])
})

it.each(['file', 'link'] as const)('Windows output refuses an occupied %s pathname before opening it', kind => {
  const out = 'C:\\Temp\\fixture\\report.json'
  add(out, kind, 0n, win32.join(project, 'created'))
  const before = snapshot()
  expect(() => reporting.writeReport(out, {})).toThrow()
  expect(open).not.toHaveBeenCalled()
  expect(write).not.toHaveBeenCalled()
  expect(snapshot()).toEqual(before)
})

it('Windows output can still create a genuinely new explicit report', () => {
  const out = 'C:\\Temp\\fixture\\new.json'
  reporting.writeReport(out, { mode: 'report' })
  expect(open).toHaveBeenCalledOnce()
  expect(write).toHaveBeenCalledWith(7, '{\n  "mode": "report"\n}\n')
})
