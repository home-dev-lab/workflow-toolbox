import { spawn } from 'node:child_process'
import { createRequire } from 'node:module'
import { existsSync, mkdirSync, openSync, readFileSync, renameSync, statSync } from 'node:fs'
import { delimiter, dirname, join, resolve as resolvePath } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { findObserveRoot } from './observe-checkout.js'
import type { RemoteEntry } from './observe-config.js'

export { isInvokedDirectly } from '../../../../plugin/bin/lib/host/entry-guard.mjs'

// Restore the companion entry's argv before its import, including --watch.
export async function runObserveServer() {
  const entry = resolvePath(process.argv[3]!)
  process.argv.splice(1, 2)
  process.argv[1] = entry
  try { process.title = 'wt-observe-srv' } catch { /* Best-effort on unsupported hosts. */ }
  await import(pathToFileURL(entry).href)
}

export function requireObserveRoot(): string {
  const base = findObserveRoot(process.cwd(), process.env)
  if (base === null) {
    throw new Error(
      'cannot locate the observe server (no checkout found from cwd; set DWT_OBSERVE_ROOT). ' +
        'Until the Workflow Observatory binary distribution ships, wt-observe start needs a ' +
        'workflow-observatory checkout (or a legacy workflow-toolbox one) on this machine.',
    )
  }
  return base
}

export function openLogFileAt(path: string, rotateBytes: number): number {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 })
  try {
    if (existsSync(path) && statSync(path).size > rotateBytes) renameSync(path, `${path}.1`)
  } catch { /* Rotation is best-effort. */ }
  return openSync(path, 'a', 0o600)
}

export function readLogSliceFrom(path: string, offset: number): string {
  try {
    const buf = readFileSync(path)
    return buf.subarray(Math.min(offset, buf.length)).toString('utf8')
  } catch { return '' }
}

export function logTail(logPath: string, lines = 5): string {
  try {
    const text = readFileSync(logPath, 'utf8')
    const tail = text.split('\n').filter(Boolean).slice(-lines).join('\n')
    return tail.length > 0 ? `log tail (${logPath}):\n${tail}` : `log is empty (${logPath})`
  } catch { return `log unreadable (${logPath})` }
}

interface SpawnFlags {
  watch: boolean
  enableLaunch: boolean
  noResume: boolean
}

function serverEnvironment(port: number, sourceDirs: readonly string[], remotes: readonly RemoteEntry[], flags: SpawnFlags, token: string, launchAgentsDir: string | null) {
  return {
    ...process.env,
    CLAUDE_CONFIG_DIR: sourceDirs[0]!,
    OBSERVE_SOURCES: sourceDirs.join(delimiter),
    OBSERVE_UI_SERVER_PORT: String(port),
    OBSERVE_UI_TOKEN: token,
    ...(remotes.length > 0 ? { OBSERVE_REMOTES: JSON.stringify(remotes) } : {}),
    ...(flags.enableLaunch ? { OBSERVE_UI_ENABLE_LAUNCH: '1' } : {}),
    ...(flags.noResume ? { OBSERVE_UI_NO_RESUME: '1' } : {}),
    ...(process.env['OBSERVE_LAUNCH_PLUGIN_DIRS'] === undefined && launchAgentsDir !== null
      ? { OBSERVE_LAUNCH_PLUGIN_DIRS: launchAgentsDir } : {}),
  }
}

function resolveTsxCli(base: string): string {
  try { return createRequire(join(base, 'package.json')).resolve('tsx/cli') } catch {
    throw new Error(`observe base ${base} has no resolvable 'tsx' — run pnpm install in ${base}`)
  }
}

interface SpawnOptions {
  base: string
  entryUrl: string
  port: number
  sourceDirs: readonly string[]
  remotes: readonly RemoteEntry[]
  flags: SpawnFlags
  token: string
  launchAgentsDir: string | null
  log: number
}

export function spawnObserveChild({ base, entryUrl, port, sourceDirs, remotes, flags, token, launchAgentsDir, log }: SpawnOptions) {
  const tsxCli = resolveTsxCli(base)
  const child = spawn(process.execPath, [tsxCli, fileURLToPath(entryUrl), '--internal-serve', 'apps/observe-ui/server/dev-api.ts', ...(flags.watch ? ['--watch'] : [])], {
    cwd: base,
    env: serverEnvironment(port, sourceDirs, remotes, flags, token, launchAgentsDir),
    detached: true,
    windowsHide: true,
    stdio: ['ignore', log, log],
  })
  let spawnError: Error | null = null
  let exited: { code: number | null; signal: NodeJS.Signals | null } | null = null
  child.once('error', (e) => { spawnError = e })
  child.once('exit', (code, signal) => { exited = { code, signal } })
  child.unref()
  return { child, spawnState: () => ({ error: spawnError, exited }) }
}
