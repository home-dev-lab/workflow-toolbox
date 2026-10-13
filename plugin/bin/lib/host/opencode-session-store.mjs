import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

export function usageDirectory(directory) {
  try { return fs.realpathSync.native(directory) } catch (error) {
    if (error?.code === 'ENOENT') return path.resolve(directory)
    throw error
  }
}

export function defaultOpenCodeDb(options = {}) {
  if (options.dbPath) return options.dbPath
  const env = options.env ?? process.env
  if (env.WT_OPENCODE_DB) return env.WT_OPENCODE_DB
  if ((options.platform ?? process.platform) !== 'linux') return null
  return path.join(env.XDG_DATA_HOME || path.join(env.HOME || os.homedir(), '.local', 'share'), 'opencode', 'opencode.db')
}

export function queryOpenCodeSessions({ dbPath, sqlite = 'sqlite3', execFile = execFileSync, directory, startedAt, endedAt = Date.now(), createdOnly = false, allSessions = false }) {
  const quote = (value) => `'${String(value).replaceAll("'", "''")}'`
  const lower = createdOnly ? 'time_created' : 'time_updated'
  const filter = allSessions ? '' : ` WHERE directory=${quote(directory)} AND ${lower}>=${Math.floor(startedAt)} AND time_created<=${Math.ceil(endedAt)}`
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
  const base = cwd ?? process.cwd()
  return usageDirectory(dirIndex < 0 ? base : path.resolve(base, args[dirIndex + 1]))
}

function captureReceipt({ sandbox, cwd, args, startedAt, env, platform, usageReader, usageReceipt }) {
  const receipt = { version: 1, receipt_for: path.basename(usageReceipt), source: 'opencode session store', ...captureStore(sandbox, env, platform), sandbox: sandbox.kind, directory: null, captured_at: new Date().toISOString(), status: 'unavailable', sessions: [] }
  try {
    receipt.directory = requestedDirectory(cwd, args)
    if (!receipt.store) throw new Error(`OpenCode store location unverified on ${platform}`)
    receipt.sessions = queryOpenCodeSessions({ dbPath: receipt.store, directory: receipt.directory, startedAt, createdOnly: true, allSessions: receipt.store_kind === 'private', execFile: usageReader })
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
