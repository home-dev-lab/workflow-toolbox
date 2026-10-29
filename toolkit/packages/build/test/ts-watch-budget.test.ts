import { EventEmitter } from 'node:events'
import fs from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import ts from 'typescript'
import { afterEach, expect, it, vi } from 'vitest'
import * as installed from '../../../../plugin/bin/lib/host/ts-watch-policy.mjs'
import { testPluginRoot } from './helpers/ts-watch-fixture.js'

const policy: typeof installed = process.env.WT_TSLS_TEST_PLUGIN_ROOT
  ? await import(pathToFileURL(join(testPluginRoot, 'bin/lib/host/ts-watch-policy.mjs')).href) : installed
const handles: fs.FSWatcher[] = []
afterEach(() => {
  handles.splice(0).forEach((handle) => handle.close())
  vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks()
})

function setup(budget = 0) {
  vi.useFakeTimers()
  const nativeCloses: Array<() => void> = []
  const native = vi.fn<(file: fs.PathLike, options: unknown, listener: unknown) => fs.FSWatcher>(() => {
    const close = vi.fn()
    nativeCloses.push(close)
    return Object.assign(new EventEmitter(), { close, ref: vi.fn(), unref: vi.fn() }) as unknown as fs.FSWatcher
  })
  const watch = policy.createBoundedFsWatch(ts, native as unknown as typeof fs.watch, { budget })
  const subscribe = (file = 'value.ts', options: fs.WatchOptions = {}) => {
    const handle = watch(file, options, vi.fn())
    handles.push(handle)
    return handle
  }
  return { native, nativeCloses, watch, subscribe }
}

it('caps native registrations and returns exactly one slot on close', () => {
  const s = setup(2), first = s.subscribe('one.ts')
  s.subscribe('two.ts')
  expect(() => s.subscribe('three.ts')).toThrow(expect.objectContaining({ code: 'ENOSPC' }))
  expect(s.native, 'native registration budget must cap allocations').toHaveBeenCalledTimes(2)
  first.close(); first.close()
  expect(s.nativeCloses[0], 'closing twice must close the native handle exactly once').toHaveBeenCalledTimes(1)
  s.subscribe('four.ts')
  expect(() => s.subscribe('five.ts')).toThrow(expect.objectContaining({ code: 'ENOSPC' }))
  expect(s.native, 'closing twice must return exactly one budget slot').toHaveBeenCalledTimes(3)
})

it.each(['node_modules/pkg/value.d.ts', '.git/input.ts', 'dist/value.ts', 'build/value.ts', 'out/value.ts', 'coverage/value.ts', '.next/value.ts', '.turbo/value.ts'])('hands overflow for %s back to TypeScript without scanning', (file) => {
  const s = setup(), timers = vi.spyOn(globalThis, 'setInterval'), reads = vi.spyOn(fs, 'statSync')
  expect(() => s.subscribe(file), 'overflow must throw ENOSPC for TypeScript polling fallback').toThrow(expect.objectContaining({ code: 'ENOSPC' }))
  expect(s.native).not.toHaveBeenCalled()
  expect(reads, 'admission must not scan the subscribed path').not.toHaveBeenCalled()
  expect(timers, 'the preload must not own a polling scanner').not.toHaveBeenCalled()
})

it('hands recursive requests back to TypeScript before native expansion', () => {
  const s = setup(64)
  expect(() => s.subscribe('workspace', { recursive: true }), 'recursive native requests must use TypeScript fallback').toThrow(expect.objectContaining({ code: 'ENOSPC' }))
  expect(s.native).not.toHaveBeenCalled()
  s.subscribe()
  expect(s.native, 'recursive refusal must not consume a native slot').toHaveBeenCalledTimes(1)
})

it('propagates native allocation failures without consuming capacity', () => {
  const s = setup(1), error = Object.assign(new Error('quota'), { code: 'ENOSPC' })
  s.native.mockImplementationOnce(() => { throw error })
  expect(() => s.subscribe(), 'TypeScript must receive the original native allocation error').toThrow(error)
  s.subscribe()
  expect(s.native).toHaveBeenCalledTimes(2)
})

it('returns every budget slot after asynchronous native errors', () => {
  const s = setup(2)
  s.subscribe()
  const second = s.subscribe()
  s.native.mock.results[0]!.value!.emit('error', new Error('gone'))
  expect(s.nativeCloses[0], 'asynchronous native error must close the native handle before any explicit close').toHaveBeenCalledTimes(1)
  s.subscribe()
  expect(s.native, 'the errored slot must be reusable while the other handle is still open').toHaveBeenCalledTimes(3)
  second.close()
  s.subscribe()
  expect(s.native, 'asynchronous native errors must return every budget slot for replacement subscriptions').toHaveBeenCalledTimes(4)
  expect(() => s.subscribe()).toThrow(expect.objectContaining({ code: 'ENOSPC' }))
  expect(s.native).toHaveBeenCalledTimes(4)
})

it.each(['buffer', 'hex', 'utf8'] as const)('returns the native handle with unchanged %s options and callback', (encoding) => {
  const s = setup(1), callback = vi.fn(), signal = new AbortController().signal
  const options = { persistent: false, signal, encoding }, handle = s.watch('value.ts', options, callback)
  handles.push(handle)
  expect(handle, 'admitted watches must use the native handle, without a scanner facade').toBe(s.native.mock.results[0]!.value)
  expect(s.native).toHaveBeenCalledWith('value.ts', options, callback)
  handle.ref(); handle.unref()
  expect(handle.ref).toHaveBeenCalledTimes(1); expect(handle.unref).toHaveBeenCalledTimes(1)
  expect(vi.getTimerCount(), 'native admission must not allocate preload timers').toBe(0)
})

type WatchSystem = { watchFile: NonNullable<typeof ts.sys.watchFile>; watchDirectory: NonNullable<typeof ts.sys.watchDirectory> }
function typescriptSystem(budget = 0, recursive = false) {
  const s = setup(budget), modified = { value: new Date(1000) }, directories = new Map<string, string[]>()
  const polling = vi.fn<(file: string, callback: ts.FileWatcherCallback, interval: number) => { close: () => void }>(() => ({ close: vi.fn() }))
  const factory = (ts as unknown as { createSystemWatchFunctions(host: object): WatchSystem }).createSystemWatchFunctions
  const system = factory({
    fsWatchWorker: (file: string, recursive: boolean, callback: fs.WatchListener<string>) => s.watch(file, { recursive }, callback),
    pollingWatchFileWorker: polling, getModifiedTime: () => modified.value, setTimeout, clearTimeout,
    fileSystemEntryExists: () => true, useCaseSensitiveFileNames: true, getCurrentDirectory: () => process.cwd(),
    fsSupportsRecursiveFsWatch: recursive, getAccessibleSortedChildDirectories: () => [], realpath: (file: string) => file,
    inodeWatching: false, fsWatchWithTimestamp: false, sysLog: () => {},
  })
  const originalDirectory = vi.fn<WatchSystem['watchDirectory']>((...args) => {
    const handle = system.watchDirectory(...args)
    vi.spyOn(handle, 'close')
    return handle
  })
  const host = { ...ts.sys, ...system, watchDirectory: originalDirectory, directoryExists: () => true, getDirectories: (directory: string) => directories.get(directory) ?? [], realpath: (file: string) => file }
  const watchDirectory = policy.createPollingDirectoryWatch(ts, host)
  // Keep the original dispatcher captured above separate from the paired adapter.
  const paired = { ...system, watchDirectory }
  return { ...s, system: paired, polling, modified, directories, originalDirectory }
}

it.each([ts.PollingWatchKind.FixedInterval, ts.PollingWatchKind.PriorityInterval, ts.PollingWatchKind.DynamicPriority, ts.PollingWatchKind.FixedChunkSize])('uses TypeScript file fallback strategy %s after native refusal', (fallbackPolling) => {
  const s = typescriptSystem(), callback = vi.fn()
  const handle = s.system.watchFile('dependency.d.ts', callback, 250, { watchFile: ts.WatchFileKind.UseFsEvents, fallbackPolling })
  try {
    if (fallbackPolling <= ts.PollingWatchKind.PriorityInterval) {
      expect(s.polling, 'native refusal must enter TypeScript polling worker').toHaveBeenCalledTimes(1)
      s.polling.mock.calls[0]![1]('dependency.d.ts', ts.FileWatcherEventKind.Changed, new Date(2000))
    } else { s.modified.value = new Date(2000); vi.advanceTimersByTime(5000) }
    expect(callback, 'TypeScript polling must deliver the dependency edit').toHaveBeenCalled()
    expect(s.native).not.toHaveBeenCalled()
  } finally { handle.close() }
})

it.each([false, true])('uses TypeScript directory fallback (native recursive support=%s)', (recursive) => {
  const s = typescriptSystem(0, recursive), callback = vi.fn()
  const handle = s.system.watchDirectory('workspace', callback, recursive, { watchDirectory: ts.WatchDirectoryKind.UseFsEvents })
  try {
    expect(s.polling, 'directory refusal must enter TypeScript polling worker').toHaveBeenCalledTimes(1)
    s.polling.mock.calls[0]![1]('workspace', ts.FileWatcherEventKind.Changed, new Date(2000))
    expect(callback, 'TypeScript must deliver the directory invalidation').toHaveBeenCalled()
    expect(s.native).not.toHaveBeenCalled()
  } finally { handle.close() }
  expect(s.originalDirectory.mock.results[0]!.value!.close, 'the original directory subscription must close with the paired handle').toHaveBeenCalledTimes(1)
  expect(s.polling.mock.results[0]!.value!.close, 'supplemental directory poll must close with its original handle').toHaveBeenCalledTimes(1)
})

it('closes every original directory handle when supplemental registration throws', () => {
  const closes: Array<ReturnType<typeof vi.fn>> = [], error = new Error('supplemental registration failed')
  const original = vi.fn(() => { const close = vi.fn(); closes.push(close); return { close } })
  const supplemental = vi.fn(() => { throw error })
  const local = { ...ts, createSystemWatchFunctions: () => ({ watchDirectory: supplemental }) }
  const watch = policy.createPollingDirectoryWatch(local, { ...ts.sys, watchDirectory: original })
  for (let attempt = 0; attempt < 3; attempt++) expect(() => watch('workspace', vi.fn(), true)).toThrow(error)
  expect(original).toHaveBeenCalledTimes(3)
  expect(supplemental).toHaveBeenCalledTimes(3)
  expect(closes.map((close) => close.mock.calls.length), 'failed supplemental registration must leave zero unowned original handles').toEqual([1, 1, 1])
})

it.each([false, true])('discovers new child directories through TypeScript recursive fallback (native recursive support=%s)', (recursive) => {
  const s = typescriptSystem(0, recursive), callback = vi.fn(), root = process.cwd().replaceAll('\\', '/') + '/workspace'
  const child = `${root}/new-child`
  const handle = s.system.watchDirectory(root, callback, true, { watchDirectory: ts.WatchDirectoryKind.UseFsEvents })
  try {
    expect(s.polling.mock.calls.map(([file]) => file)).not.toContain(child)
    s.directories.set(root, [child])
    s.polling.mock.calls.find(([file]) => file === root)![1](root, ts.FileWatcherEventKind.Changed, new Date(2000))
    const childPoll = s.polling.mock.calls.find(([file]) => file === child)
    expect(childPoll, 'recursive fallback must discover a child created after registration').toBeDefined()
    callback.mockClear()
    childPoll![1](child, ts.FileWatcherEventKind.Changed, new Date(3000))
    expect(callback, 'an event inside the newly discovered child must reach the root subscriber').toHaveBeenCalledWith(child)
    expect(s.native).not.toHaveBeenCalled()
  } finally { handle.close() }
})

it('uses TypeScript ENOSPC admission latch after the native budget fills', () => {
  const s = typescriptSystem(1), options = { watchFile: ts.WatchFileKind.UseFsEvents }
  const first = s.system.watchFile('one.ts', vi.fn(), 250, options)
  const second = s.system.watchFile('two.ts', vi.fn(), 250, options)
  first.close()
  const third = s.system.watchFile('three.ts', vi.fn(), 250, options)
  try {
    expect(s.polling, 'ENOSPC must transfer later subscriptions to TypeScript polling').toHaveBeenCalledTimes(2)
    expect(s.native, 'TypeScript must stop retrying native admission after ENOSPC').toHaveBeenCalledTimes(1)
  } finally { second.close(); third.close() }
})

it('keeps TypeScript file strategy dispatch and explicit project watch options intact', () => {
  const watchFile = vi.fn<NonNullable<typeof ts.sys.watchFile>>(() => ({ close: vi.fn() }))
  const watchDirectory = vi.fn<NonNullable<typeof ts.sys.watchDirectory>>(() => ({ close: vi.fn() }))
  const local = { ...ts, sys: { ...ts.sys, watchFile, watchDirectory } }
  const filesystem = { watch: vi.fn(() => new EventEmitter()), watchFile: vi.fn(), promises: { watch: vi.fn() } }
  const polling = filesystem.watchFile
  policy.boundTypeScriptWatches(local, filesystem)
  expect(local.sys.watchFile, 'file polling strategy dispatch must remain TypeScript-owned').toBe(watchFile)
  expect(local.sys.watchDirectory, 'directory fallback must supplement the original TypeScript dispatcher').not.toBe(watchDirectory)
  expect(filesystem.watchFile, 'explicit polling subscriptions must not be intercepted').toBe(polling)
  const options = { watchDirectory: ts.WatchDirectoryKind.DynamicPriorityPolling, excludeDirectories: ['cache'], synchronousWatchDirectory: false }
  const before = structuredClone(options), callback = vi.fn()
  const handle = local.sys.watchDirectory('workspace', callback, false, options)
  expect(watchDirectory, 'the original project-selected directory strategy must remain subscribed').toHaveBeenCalledWith('workspace', callback, false, options)
  expect(options).toEqual(before)
  expect(watchFile, 'directory mtime changes need a separately forwarded TypeScript poll').toHaveBeenCalledWith('workspace', expect.any(Function), 500, { watchFile: ts.WatchFileKind.PriorityPollingInterval })
  handle.close()
  expect(watchDirectory.mock.results[0]!.value!.close, 'dispatch must close the original project-selected directory handle').toHaveBeenCalledTimes(1)
  expect(watchFile.mock.results[0]!.value!.close, 'dispatch must close the supplemental directory poll').toHaveBeenCalledTimes(1)
})

type ClosedInput = { fileName: string; fileWatcher?: ts.FileWatcher }
function closedService(watched = true) {
  const original = { close: vi.fn() }, poll = { close: vi.fn() }, changed = vi.fn(), initial = vi.fn()
  class ProjectService {
    watchClosedScriptInfo(info: ClosedInput) { initial(info); if (watched) info.fileWatcher = original }
    onSourceFileChanged = changed
  }
  const watchFile = vi.fn<(file: string, callback: ts.FileWatcherCallback, interval?: number, options?: ts.WatchOptions) => ts.FileWatcher>(() => poll)
  const local = { sys: { watchFile }, WatchFileKind: ts.WatchFileKind, server: { ProjectService } }
  policy.observeClosedProgramInputs(local)
  return { service: new ProjectService(), original, poll, changed, initial, watchFile }
}

it('pairs closed-input polls with the original subscription and closes both once', () => {
  const s = closedService(), info: ClosedInput = { fileName: 'node_modules/pkg/index.d.ts' }
  s.service.watchClosedScriptInfo(info)
  expect(s.initial).toHaveBeenCalledWith(info)
  expect(s.watchFile, 'each watched closed input must gain a TypeScript-owned individual poll').toHaveBeenCalledWith(info.fileName, expect.any(Function), 500, { watchFile: ts.WatchFileKind.PriorityPollingInterval })
  s.watchFile.mock.calls[0]![1](info.fileName, ts.FileWatcherEventKind.Changed)
  expect(s.changed, 'the poll must use the existing server file-change handler').toHaveBeenCalledWith(info, ts.FileWatcherEventKind.Changed)
  expect(s.original.close, 'metadata and directory subscriptions must remain live').not.toHaveBeenCalled()
  info.fileWatcher!.close(); info.fileWatcher!.close()
  expect(s.original.close).toHaveBeenCalledTimes(1)
  expect(s.poll.close).toHaveBeenCalledTimes(1)
})

it('closes the paired poll even when the original closed-input close throws', () => {
  const s = closedService(), info: ClosedInput = { fileName: 'node_modules/pkg/index.d.ts' }
  const error = new Error('original close failed')
  s.original.close.mockImplementation(() => { throw error })
  s.service.watchClosedScriptInfo(info)
  expect(() => info.fileWatcher!.close()).toThrow(error)
  expect(s.poll.close, 'a throwing original close must not strand the paired poll').toHaveBeenCalledTimes(1)
  info.fileWatcher!.close()
  expect(s.original.close).toHaveBeenCalledTimes(1)
  expect(s.poll.close).toHaveBeenCalledTimes(1)
})

it('keeps server-exempt dynamic inputs free of supplemental polls', () => {
  const s = closedService(false), info: ClosedInput = { fileName: '^dynamic' }
  s.service.watchClosedScriptInfo(info)
  expect(s.initial).toHaveBeenCalledWith(info)
  expect(s.watchFile, 'server-exempt inputs must not gain a poll').not.toHaveBeenCalled()
  expect(info.fileWatcher).toBeUndefined()
})

it('shares native admission with promises.watch instead of installing another poller', async () => {
  const s = setup(), controller = new AbortController()
  vi.stubEnv('WT_TSLS_NATIVE_WATCH_BUDGET', '0')
  const filesystem = { watch: s.native, promises: { watch: fs.promises.watch } }
  policy.boundTypeScriptWatches(ts, filesystem)
  const iterator = filesystem.promises.watch('dependency.d.ts', { signal: controller.signal }), rejected = vi.fn()
  const pending = iterator.next().catch(rejected)
  try {
    await vi.advanceTimersByTimeAsync(1)
    expect(rejected, 'promises overflow must expose the same native refusal').toHaveBeenCalledWith(expect.objectContaining({ code: 'ENOSPC' }))
    expect(s.native).not.toHaveBeenCalled()
  } finally { controller.abort(); await pending; await iterator.return?.() }
})

it('uses the named default, accepts zero budget, and rejects invalid environment settings', () => {
  expect(policy.DEFAULT_NATIVE_WATCH_BUDGET).toBe(64)
  const s = setup()
  vi.stubEnv('WT_TSLS_NATIVE_WATCH_BUDGET', '0')
  expect(() => policy.createBoundedFsWatch(ts, s.native as unknown as typeof fs.watch)('value.ts', {})).toThrow(expect.objectContaining({ code: 'ENOSPC' }))
  for (const value of ['-1', 'NaN', '0.5', '']) {
    vi.stubEnv('WT_TSLS_NATIVE_WATCH_BUDGET', value)
    handles.push(policy.createBoundedFsWatch(ts, s.native as unknown as typeof fs.watch)('value.ts', {}))
  }
  expect(s.native).toHaveBeenCalledTimes(4)
})
