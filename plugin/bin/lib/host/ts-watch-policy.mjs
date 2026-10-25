import filesystem from 'node:fs'
import { on } from 'node:events'

export const DEFAULT_NATIVE_WATCH_BUDGET = 64
const TYPESCRIPT_POLL_INTERVAL_MS = 500

function setting(value, fallback, minimum) {
  const number = Number(value)
  return value?.trim() && Number.isSafeInteger(number) && number >= minimum ? number : fallback
}

// TypeScript catches native watch failures and selects its configured polling
// fallback. ENOSPC also latches its system-watcher-limit admission state.
function pollingRequired() {
  return Object.assign(new Error('wt-tsls: native watch budget requires TypeScript polling'), { code: 'ENOSPC' })
}

export function createBoundedFsWatch(_ts, nativeWatch = filesystem.watch, settings = {}) {
  const budget = settings.budget ?? setting(process.env.WT_TSLS_NATIVE_WATCH_BUDGET, DEFAULT_NATIVE_WATCH_BUDGET, 0)
  let allocated = 0
  return (file, options, listener) => {
    if (typeof options === 'function') { listener = options; options = {} }
    if (typeof options === 'string') options = { encoding: options }
    // A recursive Node registration can expand into unbounded native watches.
    // Refuse it before allocation; TypeScript owns recursive fallback coverage.
    if (options?.recursive || allocated >= budget) throw pollingRequired()
    const handle = nativeWatch(file, options, listener)
    allocated++
    let released = false
    const nativeClose = handle.close.bind(handle)
    const release = () => { if (!released) { released = true; allocated-- } }
    handle.close = () => { if (!released) { release(); nativeClose() } }
    handle.on('error', () => handle.close())
    handle.on('close', release)
    return handle
  }
}

function boundedPromisesWatch(watch) {
  return async function* (file, options) {
    // The iterator owns cancellation; a prior FSWatcher close would otherwise
    // resolve a pending next() as done before on() can reject with AbortError.
    const watcher = watch(file, typeof options === 'string' ? options : { ...options, signal: undefined })
    try {
      for await (const [eventType, filename] of on(watcher, 'change', { signal: options?.signal, close: ['close'] })) yield { eventType, filename }
    } finally { watcher.close() }
  }
}

function closeTogether(first, second) {
  let closed = false
  return { close() {
    if (closed) return
    closed = true
    try { first.close() } finally { second.close() }
  } }
}

// Keep the project's original directory strategy. A separate TypeScript-owned
// directory poll forwards Changed events that its fs-events fallback discards.
// Its recursive helper, not this preload, owns discovery and symlink handling.
export function createPollingDirectoryWatch(ts, system = ts.sys) {
  const original = system.watchDirectory.bind(system)
  const fallback = ts.createSystemWatchFunctions({
    pollingWatchFileWorker: (file, callback, interval) => system.watchFile(file, callback, interval, { watchFile: ts.WatchFileKind.PriorityPollingInterval }),
    getModifiedTime: (file) => system.getModifiedTime(file), setTimeout, clearTimeout,
    fsWatchWorker: () => { throw pollingRequired() },
    fileSystemEntryExists: (directory) => system.directoryExists(directory),
    useCaseSensitiveFileNames: system.useCaseSensitiveFileNames,
    getCurrentDirectory: () => system.getCurrentDirectory(),
    fsSupportsRecursiveFsWatch: false,
    getAccessibleSortedChildDirectories: (directory) => system.getDirectories(directory),
    realpath: (file) => system.realpath?.(file) ?? file,
    inodeWatching: false, fsWatchWithTimestamp: false, sysLog: () => {},
  }).watchDirectory
  return (directory, callback, recursive, options) => {
    const first = original(directory, callback, recursive, options)
    try {
      return closeTogether(first, fallback(directory, callback, recursive, { ...options, watchDirectory: ts.WatchDirectoryKind.FixedPollingInterval, synchronousWatchDirectory: true }))
    } catch (error) {
      first.close()
      throw error
    }
  }
}

// ProjectService normally shares directory watches for node_modules script infos.
// A closed program input also needs its own sample when native admission is zero.
// Use the server's existing change handler and lifetime; do not reload its cache here.
export function observeClosedProgramInputs(ts) {
  const prototype = ts.server.ProjectService.prototype
  const original = prototype.watchClosedScriptInfo
  prototype.watchClosedScriptInfo = function (info) {
    original.call(this, info)
    if (!info.fileWatcher) return
    const poll = ts.sys.watchFile(
      info.fileName, (_file, event) => this.onSourceFileChanged(info, event),
      TYPESCRIPT_POLL_INTERVAL_MS, { watchFile: ts.WatchFileKind.PriorityPollingInterval },
    )
    info.fileWatcher = closeTogether(info.fileWatcher, poll)
  }
}

// No filesystem snapshots or preload polling timers: TypeScript owns sampling.
export function boundTypeScriptWatches(ts, fs = filesystem) {
  fs.watch = createBoundedFsWatch(ts, fs.watch.bind(fs))
  if (fs.promises) fs.promises.watch = boundedPromisesWatch(fs.watch)
  ts.sys.watchDirectory = createPollingDirectoryWatch(ts)
}
