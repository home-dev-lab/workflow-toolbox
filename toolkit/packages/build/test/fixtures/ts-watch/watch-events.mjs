import fs from 'node:fs'
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { syncBuiltinESMExports } from 'node:module'

// Test-owned observation of events actually delivered by the installed transport.
// This runs after the production preload, independently of its implementation.
const output = process.env.WT_TSLS_TEST_WATCH_EVENTS
const watch = fs.watch
const watchFile = fs.watchFile, unwatchFile = fs.unwatchFile
const callbacks = new WeakMap()
if (output) fs.watchFile = (file, options, listener) => {
  if (typeof options === 'function') { listener = options; options = {} }
  fs.appendFileSync(`${output}.subscriptions`, `${JSON.stringify(resolve(String(file)))}\n`)
  const callback = (current, previous) => {
    const line = `${JSON.stringify(resolve(String(file)))}\n`
    fs.appendFileSync(output, line)
    fs.appendFileSync(`${output}.polling`, line)
    listener(current, previous)
  }
  callbacks.set(listener, callback)
  return watchFile(file, options, callback)
}
if (output) fs.unwatchFile = (file, listener) => unwatchFile(file, callbacks.get(listener) ?? listener)
if (output) fs.watch = (file, ...args) => {
  const path = file instanceof URL ? fileURLToPath(file) : String(file)
  const directory = fs.statSync(path).isDirectory()
  const handle = watch(file, ...args)
  handle.on('change', (_event, name) => {
    const changed = directory ? resolve(path, String(name ?? '')) : resolve(path)
    if (changed !== output) fs.appendFileSync(output, `${JSON.stringify(changed)}\n`)
  })
  return handle
}
syncBuiltinESMExports()
