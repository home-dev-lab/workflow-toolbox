import { spawnSync } from 'node:child_process'
import { readdirSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { classifyLane } from './lane-supervisor-core.mjs'

const RECORD_NAME = /^\d+-\d+\.json$/
const LIVE_STATUSES = new Set(['running', 'decision-needed', 'launching'])
const INACTIVE_STATUSES = new Set(['gone', 'terminal', 'worker-gone-child-alive'])

function missing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

function plainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function readRecord(file, readFileImpl) {
  try {
    const value = JSON.parse(readFileImpl(file, 'utf8'))
    return plainObject(value) ? { value } : { reason: 'record unreadable' }
  } catch {
    return { reason: 'record unreadable' }
  }
}

function ownership(record, sessionId) {
  if (record.owner === 'pilot') return 'pilot'
  if (record.owner !== 'session') return 'unattributable'
  if (typeof record.ownerSessionId !== 'string' || record.ownerSessionId === '') return 'unattributable'
  if (typeof sessionId !== 'string' || sessionId === '') return 'unattributable'
  return record.ownerSessionId === sessionId ? 'owned' : 'foreign'
}

function classifyRecord(record, sessionId, classify) {
  if (record.state === 'launch-failed') return { status: 'none' }
  const owner = ownership(record, sessionId)
  if (owner === 'pilot' || owner === 'foreign') return { status: 'none' }
  let verdict
  try {
    verdict = classify(record)
  } catch {
    return { status: 'unknown', reason: 'lane classification threw' }
  }
  if (LIVE_STATUSES.has(verdict?.status)) {
    return owner === 'owned'
      ? { status: 'in-flight', reason: verdict.reason ?? verdict.status }
      : { status: 'unknown', reason: 'lane ownership unattributable' }
  }
  if (INACTIVE_STATUSES.has(verdict?.status)) return { status: 'none' }
  return {
    status: 'unknown',
    reason: owner === 'unattributable' ? 'lane ownership unattributable' : verdict?.reason ?? 'lane classification unknown',
  }
}

function gitWorktrees(projectDir, spawnSyncImpl) {
  let result
  try {
    result = spawnSyncImpl('git', ['-C', projectDir, 'worktree', 'list', '--porcelain', '-z'], {
      encoding: 'utf8',
      env: { ...process.env, LC_ALL: 'C' },
      timeout: 5_000,
    })
  } catch {
    return { paths: [], reason: 'git worktree list unavailable' }
  }
  if (result?.error) return { paths: [], reason: 'git worktree list unavailable' }
  if (result?.status !== 0) {
    return /not a git repository/i.test(String(result?.stderr))
      ? { paths: [] }
      : { paths: [], reason: 'git worktree list unavailable' }
  }
  const paths = String(result.stdout ?? '').split('\0')
    .filter((field) => field.startsWith('worktree '))
    .map((field) => field.slice('worktree '.length))
  return paths.length ? { paths } : { paths: [], reason: 'git worktree list unavailable' }
}

function umbrellaWorktrees(projectDir, readdirImpl, maxUmbrellaEntries) {
  const root = path.join(projectDir, '.claude', 'worktrees')
  let entries
  try {
    entries = readdirImpl(root, { withFileTypes: true })
  } catch (error) {
    return missing(error) ? { paths: [] } : { paths: [], reason: 'worktree directory unreadable' }
  }
  const candidates = entries.filter((entry) => entry.isDirectory() || entry.isSymbolicLink())
  return {
    paths: candidates.slice(0, maxUmbrellaEntries).map((entry) => path.join(root, entry.name)),
    ...(candidates.length > maxUmbrellaEntries ? { reason: `umbrella scan capped at ${maxUmbrellaEntries}` } : {}),
  }
}

function currentRecord(dir, entries, readFileImpl) {
  if (!entries.some((entry) => entry.name === 'current.json')) return {}
  const pointer = readRecord(path.join(dir, 'current.json'), readFileImpl)
  if (!pointer.value || typeof pointer.value.runId !== 'string' || !/^\d+-\d+$/.test(pointer.value.runId)) {
    return { reason: 'record unreadable' }
  }
  return { name: `${pointer.value.runId}.json` }
}

export function sessionLaneInFlight({
  projectDir,
  sessionId,
  readdirImpl = readdirSync,
  readFileImpl = readFileSync,
  spawnSyncImpl = spawnSync,
  classify = classifyLane,
  maxWorktrees = 500,
  maxUmbrellaEntries = 200,
  maxRecords = 1000,
}) {
  const unknowns = []
  const git = gitWorktrees(projectDir, spawnSyncImpl)
  const umbrella = umbrellaWorktrees(projectDir, readdirImpl, maxUmbrellaEntries)
  if (git.reason) unknowns.push(git.reason)
  if (umbrella.reason) unknowns.push(umbrella.reason)
  const discovered = [...new Set([path.resolve(projectDir), ...git.paths.map((item) => path.resolve(item)), ...umbrella.paths.map((item) => path.resolve(item))])]
  if (discovered.length > maxWorktrees) unknowns.push(`worktree scan capped at ${maxWorktrees}`)
  const worktrees = discovered.slice(0, maxWorktrees)
  let recordsSeen = 0

  for (const worktree of worktrees) {
    const dir = path.join(worktree, '.lane', 'supervision')
    let entries
    try {
      entries = readdirImpl(dir, { withFileTypes: true })
    } catch (error) {
      if (!missing(error)) unknowns.push('supervision dir unreadable')
      continue
    }
    const current = currentRecord(dir, entries, readFileImpl)
    if (current.reason) unknowns.push(current.reason)
    const names = entries.map((entry) => entry.name).filter((name) => RECORD_NAME.test(name)).sort()
    if (current.name && !names.includes(current.name)) unknowns.push('record unreadable')
    const ordered = current.name && names.includes(current.name)
      ? [current.name, ...names.filter((name) => name !== current.name)]
      : names
    if (recordsSeen + names.length > maxRecords) unknowns.push(`record scan capped at ${maxRecords}`)
    const available = Math.max(0, maxRecords - recordsSeen)
    const selected = current.name && ordered[0] === current.name && available === 0 ? [current.name] : ordered.slice(0, available)
    recordsSeen += names.length
    for (const name of selected) {
      const loaded = readRecord(path.join(dir, name), readFileImpl)
      if (!loaded.value) {
        unknowns.push(loaded.reason)
        continue
      }
      const verdict = classifyRecord(loaded.value, sessionId, classify)
      if (verdict.status === 'in-flight') return verdict
      if (verdict.status === 'unknown') unknowns.push(verdict.reason)
    }
  }
  return unknowns.length ? { status: 'unknown', reason: unknowns[0] } : { status: 'none', reason: 'no live owned lane' }
}
