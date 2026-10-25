import Module, { createRequire, syncBuiltinESMExports } from 'node:module'
import filesystem, { readFileSync, realpathSync } from 'node:fs'
import { basename, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { boundTypeScriptWatches, observeClosedProgramInputs } from './ts-watch-policy.mjs'

const DISABLE_ATA = '--disableAutomaticTypingAcquisition'

function patchTargets(ts) {
  return [[filesystem, 'watch'], [filesystem.promises, 'watch'],
    [ts.sys, 'watchDirectory'], [ts.server.ProjectService.prototype, 'watchClosedScriptInfo']]
}

function hasFunctions(object, names) {
  return names.every((name) => typeof object?.[name] === 'function')
}

function hasPollingKinds(ts) {
  return typeof ts.WatchFileKind?.PriorityPollingInterval === 'number' &&
    typeof ts.WatchDirectoryKind?.FixedPollingInterval === 'number'
}

function supportedSurface(ts) {
  const prototype = ts.server?.ProjectService?.prototype
  return hasFunctions(ts, ['createSystemWatchFunctions']) &&
    hasFunctions(ts.sys, ['watchFile', 'watchDirectory']) &&
    hasFunctions(prototype, ['watchClosedScriptInfo', 'onSourceFileChanged']) &&
    hasPollingKinds(ts) && Array.isArray(ts.sys?.args)
}

// Failed installation must leave neither a native cap nor half a server patch.
function applyBound(ts) {
  const saved = patchTargets(ts).map(([object, key]) => [object, key, Object.getOwnPropertyDescriptor(object, key)])
  if (saved.some(([, , descriptor]) => !descriptor?.writable)) throw new Error('immutable watch surface')
  try {
    boundTypeScriptWatches(ts)
    observeClosedProgramInputs(ts)
    syncBuiltinESMExports()
  } catch (error) {
    for (const [object, key, descriptor] of saved.reverse()) {
      try { Object.defineProperty(object, key, descriptor) } catch { /* Continue restoring the other surfaces. */ }
    }
    syncBuiltinESMExports()
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

// Observe the actual CommonJS dependency edge, not merely a neighboring compiler.
// TS 5 uses tsserver.js -> typescript.js; newer shims add _tsserver.js in between.
function awaitServerModule(entry, ts, finish) {
  const original = Module.prototype.require
  const implementation = resolve(entry, '..', '_tsserver.js')
  const callers = new Set([entry])
  const restore = () => {
    try { if (Module.prototype.require === intercepted) Module.prototype.require = original }
    catch { /* A later loader must not turn cleanup into a startup failure. */ }
  }
  const intercepted = function (id) {
    if (this.filename === entry && id === './_tsserver.js') callers.add(implementation)
    const exported = original.apply(this, arguments)
    const server = callers.has(this.filename)
    if (server && id === './typescript.js') {
      restore()
      try {
        if (exported !== ts) { finish('server-module-not-shared'); return exported }
        applyBound(ts)
        finish()
      } catch { finish('watch-installation-failed') }
    }
    return exported
  }
  Module.prototype.require = intercepted
  setImmediate(() => { restore(); finish('server-module-not-shared') })
}

function preload(entry) {
  let version = 'unknown', finished = false
  const finish = (reason) => {
    if (finished) return
    finished = true
    if (reason) {
      try { process.stderr.write(`wt-tsls: warning: TypeScript ${version}: native watch budget and closed-input polling not applied (${reason})\n`) }
      catch { /* Diagnostics must never prevent server startup. */ }
    }
  }
  try {
    // Add before loading TypeScript: sys.args snapshots argv at module evaluation.
    // Navigation uses installed types; ATA adds a separate, unbounded installer.
    process.argv.push(DISABLE_ATA)
    const realEntry = realpathSync(entry)
    version = packageVersion(realEntry)
    const require = createRequire(pathToFileURL(realEntry))
    const ts = require(resolve(realEntry, '..', 'typescript.js'))
    version = versionName(ts.version ?? version)
    if (!/^[56]\.\d+\.\d+(?:-[\w.-]+)?(?:\+[\w.-]+)?$/.test(version)) return finish('unsupported-version')
    if (!supportedSurface(ts)) return finish('unsupported-watch-surface')
    if (!ts.sys.args.includes(DISABLE_ATA)) ts.sys.args.push(DISABLE_ATA)
    awaitServerModule(realEntry, ts, finish)
  } catch { finish('preload-initialization-failed') }
}

// NODE_OPTIONS reaches all Node children; only the selected server is considered.
const entry = process.argv[1]
if (entry && /^_?tsserver\.js$/.test(basename(entry))) preload(entry)
