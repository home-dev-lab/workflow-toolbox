import Module, { createRequire, syncBuiltinESMExports } from 'node:module'
import filesystem, { readFileSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boundNativeWatches, createPollingDirectoryWatch, observeClosedProgramInputs } from './ts-watch-policy.mjs'

const DISABLE_ATA = '--disableAutomaticTypingAcquisition'

function patchTargets(ts) {
  return [[ts.sys, 'watchDirectory'], [ts.server.ProjectService.prototype, 'watchClosedScriptInfo']]
}

function hasFunctions(object, names) {
  return names.every((name) => typeof object?.[name] === 'function')
}

function hasPollingKinds(ts) {
  return typeof ts.WatchFileKind?.PriorityPollingInterval === 'number' &&
    typeof ts.WatchDirectoryKind?.FixedPollingInterval === 'number'
}

function writableMethod(object, key) {
  while (object) {
    const descriptor = Object.getOwnPropertyDescriptor(object, key)
    if (descriptor) return descriptor.writable === true && typeof descriptor.value === 'function'
    object = Object.getPrototypeOf(object)
  }
  return false
}

function writableTargets(ts) {
  return patchTargets(ts).every(([object, key]) => writableMethod(object, key))
}

function supportedSurface(ts) {
  const prototype = ts.server?.ProjectService?.prototype
  return hasFunctions(ts, ['createSystemWatchFunctions']) &&
    hasFunctions(ts.sys, ['watchFile']) &&
    hasFunctions(prototype, ['onSourceFileChanged']) &&
    writableTargets(ts) && hasPollingKinds(ts) && Array.isArray(ts.sys?.args)
}

function safely(action) {
  try { action() } catch { /* Cleanup must never replace an entry's result or suppress its warning. */ }
}

function restoreProperty([object, key, descriptor]) {
  if (descriptor) Object.defineProperty(object, key, descriptor)
  else delete object[key]
}

function insertArgument(args, inserted) {
  if (args.includes(DISABLE_ATA)) return
  args.push(DISABLE_ATA)
  inserted.push(args)
}

function removeArgument(args) {
  const index = args.indexOf(DISABLE_ATA)
  if (index !== -1) args.splice(index, 1)
}

// Restore future-call surfaces only; startup may already have consumed arguments.
// Native admission remains bounded, and unrelated startup mutations stay owned by the caller.
function applyBound(ts) {
  const saved = patchTargets(ts).map(([object, key]) => [object, key, Object.getOwnPropertyDescriptor(object, key)])
  const inserted = []
  const restore = () => {
    for (const property of saved) safely(() => restoreProperty(property))
    for (const args of inserted) safely(() => removeArgument(args))
  }
  try {
    // Navigation uses installed types; ATA adds a separate, unbounded installer.
    // argv too: a separately bundled server snapshots it when its entry evaluates.
    insertArgument(process.argv, inserted)
    insertArgument(ts.sys.args, inserted)
    ts.sys.watchDirectory = createPollingDirectoryWatch(ts)
    observeClosedProgramInputs(ts)
    return restore
  } catch (error) {
    restore()
    throw error
  }
}

function versionName(value) {
  return typeof value === 'string' && /^[\w.+-]+$/.test(value) ? value : 'unknown'
}

function packageVersion(entry) {
  try { return versionName(JSON.parse(readFileSync(resolve(entry, '../..', 'package.json'), 'utf8')).version) }
  catch { return 'unknown' }
}

// Observe module identity through any require spelling. Decide only after the
// actual entry finishes loading, so asynchronous --import preloads cannot race it.
function awaitServerModule(entry, ts, finish) {
  const original = Module.prototype.require
  const compile = Module.prototype._compile
  let shared = false, compilingEntry = false
  const restore = () => {
    safely(() => { if (Module.prototype.require === intercepted) Module.prototype.require = original })
    safely(() => { if (Module.prototype._compile === compiled) Module.prototype._compile = compile })
  }
  const intercepted = function () {
    const exported = original.apply(this, arguments)
    if (compilingEntry && exported === ts) shared = true
    return exported
  }
  const compiled = function (_content, filename) {
    const isEntry = entry.includes(filename)
    if (isEntry) compilingEntry = true
    try { return compile.apply(this, arguments) }
    finally {
      if (isEntry) {
        compilingEntry = false
        restore()
        finish(shared ? undefined : 'server-module-not-shared')
      }
    }
  }
  try {
    Module.prototype.require = intercepted
    Module.prototype._compile = compiled
  } catch (error) { restore(); throw error }
}

function refuse(reason) {
  try { filesystem.writeSync(2, `wt-tsls: error: TypeScript unknown: refusing server startup (${reason})\n`) }
  finally { process.exit(1) }
}

function warn(version, reason) {
  try { filesystem.writeSync(2, `wt-tsls: warning: TypeScript ${version}: native watch cap applied; directory polling and closed-input polling not applied (${reason})\n`) }
  catch { /* An unavailable stderr must not kill a bounded server. */ }
}

function preload(entry) {
  let version = 'unknown', finished = false, restore = () => {}
  // The hazard is uncapped native watches; this cap does not depend on the compiler.
  try { boundNativeWatches(); syncBuiltinESMExports() }
  catch { return refuse('native-watch-installation-failed') }
  const finish = (reason) => {
    if (finished) return
    finished = true
    if (reason) { safely(restore); warn(version, reason) }
  }
  try {
    const realEntry = realpathSync(entry)
    version = packageVersion(realEntry)
    const require = createRequire(pathToFileURL(realEntry))
    const ts = require(resolve(realEntry, '..', 'typescript.js'))
    version = versionName(ts.version ?? version)
    if (!/^[56]\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) return finish('unsupported-version')
    if (!supportedSurface(ts)) return finish('unsupported-watch-surface')
    try { restore = applyBound(ts) } catch { return finish('watch-installation-failed') }
    awaitServerModule([realEntry, resolve(entry)], ts, finish)
  } catch { finish('preload-initialization-failed') }
}

// NODE_OPTIONS reaches all Node children; only the selected server is considered.
const entry = process.argv[1]
if (entry && /^_?tsserver\.js$/.test(basename(entry))) preload(entry)
