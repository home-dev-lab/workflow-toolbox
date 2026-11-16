import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { canonicalDirectory } from './canonical-path.mjs'

export function usageDirectory(directory) {
  return canonicalDirectory(directory)
}

export function defaultOpenCodeDb(options = {}) {
  if (options.dbPath) return options.dbPath
  const env = options.env ?? process.env
  if (env.WT_OPENCODE_DB) return env.WT_OPENCODE_DB
  const platform = options.platform ?? process.platform
  const pathApi = platform === 'win32' ? path.win32 : path.posix
  return pathApi.join(openCodeDataDir(env, platform, pathApi), 'opencode', 'opencode.db')
}

function openCodeDataDir(env, platform, pathApi) {
  const data = env.XDG_DATA_HOME
  if (data && pathApi.isAbsolute(data)) return data
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME
  return pathApi.join(home || os.homedir(), '.local', 'share')
}

function sessionDirectoryFilter(directory, directories) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
  const clauses = (directories ?? [directory]).map((value) => `directory=${quote(value)}`)
  return clauses.length === 1 ? clauses[0] : `(${clauses.join(' OR ')})`
}

export function queryOpenCodeSessions({ dbPath, sqlite = 'sqlite3', execFile = execFileSync, directory, directories, startedAt, endedAt = Date.now(), createdOnly = false, allSessions = false }) {
  const lower = createdOnly ? 'time_created' : 'time_updated'
  const filter = allSessions ? '' : ` WHERE ${sessionDirectoryFilter(directory, directories)} AND ${lower}>=${Math.floor(startedAt)} AND time_created<=${Math.ceil(endedAt)}`
  const query = `SELECT id,directory,model,tokens_input,tokens_output,tokens_reasoning,tokens_cache_read,tokens_cache_write,time_created,time_updated FROM session${filter} ORDER BY time_created`
  const output = executeSessionQuery(execFile, sqlite, dbPath, query)
  const rows = output.trim() ? JSON.parse(output) : []
  if (!Array.isArray(rows)) throw new Error('OpenCode session query did not return rows')
  return rows
}

function executeSessionQuery(execFile, sqlite, dbPath, query) {
  try {
    return execFile(sqlite, ['-readonly', '-json', '--', dbPath, query], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024, timeout: 10_000, killSignal: 'SIGKILL' })
  } catch (error) {
    if (error?.code === 'ENOENT') throw new Error(`${sqlite} not found`)
    throw error
  }
}

function captureStore(sandbox, env, platform) {
  const privateStore = sandbox.kind === 'bwrap' && Boolean(sandbox.opencodeDataDir)
  const store = privateStore ? path.join(sandbox.opencodeDataDir, 'opencode.db') : defaultOpenCodeDb({ env, platform })
  return { store, store_kind: privateStore ? 'private' : 'shared' }
}

function requestedDirectory(cwd, args) {
  const dirIndex = args.indexOf('--dir')
  return dirIndex < 0 ? cwd ?? process.cwd() : args[dirIndex + 1]
}

function launchRealpath(requested, cwd, args) {
  if (!args.includes('--dir')) return fs.realpathSync.native(requested)
  const input = path.isAbsolute(requested) ? requested : `${cwd ?? process.cwd()}${path.sep}${requested}`
  return fs.realpathSync.native(input)
}

export function recordOpencodeLaunch(sandbox, options) {
  const { cwd, args, env, platform, usageReceipt, startedAt } = options
  const requested = requestedDirectory(cwd, args)
  const launch = { version: 1, launch_for: path.basename(usageReceipt), requested, realpath: null, spellings: [], recorded_at: startedAt, store_kind: captureStore(sandbox, env, platform).store_kind }
  try { launch.realpath = launchRealpath(requested, cwd, args) } catch (error) {
    launch.reason = error instanceof Error ? error.message : String(error)
  }
  launch.spellings = [...new Set([path.isAbsolute(requested) ? requested : null, launch.realpath].filter((value) => value !== null))]
  try { fs.writeFileSync(`${usageReceipt}.launch.json`, `${JSON.stringify(launch, null, 2)}\n`, { flag: 'wx', mode: 0o600 }) } catch { /* Launch evidence IO cannot prevent spawn. */ }
  return launch
}

function aliasBinding(launch, cwd, args) {
  try { return launch.realpath !== null && launchRealpath(launch.requested, cwd, args) === launch.realpath ? 'stable' : 'retargeted' } catch { return 'retargeted' }
}

function captureReceipt({ sandbox, cwd, args, launch, startedAt, env, platform, usageReader, usageReceipt }) {
  const receipt = { version: 1, receipt_for: path.basename(usageReceipt), source: 'opencode session store', ...captureStore(sandbox, env, platform), sandbox: sandbox.kind, directory: launch.realpath, launch, alias_binding: aliasBinding(launch, cwd, args), captured_at: new Date().toISOString(), status: 'unavailable', sessions: [] }
  try {
    if (receipt.directory === null) throw new Error(launch.reason ?? 'worktree identity unavailable')
    if (!receipt.store) throw new Error('OpenCode session store path unavailable')
    receipt.sessions = queryOpenCodeSessions({ dbPath: receipt.store, directories: launch.spellings, startedAt, createdOnly: true, allSessions: receipt.store_kind === 'private', execFile: usageReader })
    receipt.status = 'ok'
  } catch (error) {
    receipt.reason = error instanceof Error ? error.message : String(error)
  }
  return receipt
}

function captureOpencodeUsage(options) {
  try {
    const receipt = captureReceipt(options)
    fs.writeFileSync(options.usageReceipt, `${JSON.stringify(receipt, null, 2)}\n`, { flag: 'wx', mode: 0o600 })
  } catch { /* Receipt IO cannot throw into the child's close path. Missing receipt means incomplete. */ }
}

export function finishOpencodeUsage(sandbox, options) {
  try {
    if (options.usageReceipt) captureOpencodeUsage({ ...options, sandbox })
  } finally { sandbox.dispose() }
}
