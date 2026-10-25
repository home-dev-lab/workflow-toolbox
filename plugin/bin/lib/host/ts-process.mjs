import { spawn } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { monitorTsserverWatches } from './ts-watch-count.mjs'

export function tsProcessOptions(options) {
  const env = options.env ?? process.env
  const preload = fileURLToPath(new URL('./ts-watch-preload.mjs', import.meta.url))
  return { ...options, env: { ...env, NODE_OPTIONS: `${env.NODE_OPTIONS ?? ''} --import=${pathToFileURL(preload).href}`.trim() } }
}

export function spawnTsProcess(command, args, options) {
  // The native backend has no Node tsserver and needs neither the preload nor proc polling.
  if (!args[0]?.endsWith('cli.mjs')) return spawn(command, args, options)
  const child = spawn(command, args, tsProcessOptions(options))
  child.once('spawn', () => monitorTsserverWatches(child, process.stderr))
  return child
}
