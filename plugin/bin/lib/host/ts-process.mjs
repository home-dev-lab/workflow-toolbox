import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { monitorTsserverWatches } from './ts-watch-count.mjs'
import { monitorTsserverCpu } from './ts-cpu-watchdog.mjs'
import { tsCpuScope } from './ts-cpu-scope.mjs'

let cpuScope

function currentScope(services) {
  if (services.scope) return services.scope()
  cpuScope ??= tsCpuScope()
  return cpuScope
}

function scopedSpawn(command, args, options, services) {
  const scope = currentScope(services)
  const launch = services.launch ?? spawn
  if (scope.status !== 'available') return launch(command, args, options)
  return launch(scope.command, [...scope.args, command, ...args], options)
}

export function tsProcessOptions(options) {
  const env = options.env ?? process.env
  const preload = fileURLToPath(new URL('./ts-watch-preload.mjs', import.meta.url))
  return { ...options, detached: process.platform !== 'win32', env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() } }
}

export function spawnTsProcess(command, args, options, services = {}) {
  // The native backend has no Node tsserver and needs neither the preload nor proc polling.
  if (!args[0]?.endsWith('cli.mjs')) return scopedSpawn(command, args, { ...options, detached: process.platform !== 'win32' }, services)
  const child = scopedSpawn(command, args, tsProcessOptions(options), services)
  child.once('spawn', () => monitorTsserverWatches(child, process.stderr))
  child.once('spawn', () => monitorTsserverCpu(child, process.stderr))
  return child
}
