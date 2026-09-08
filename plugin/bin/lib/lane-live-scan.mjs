import { readFileSync, readdirSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { basename, join } from 'node:path'

export const ACTIVITY_MAX_ENTRIES = 4000
export const ACTIVITY_WINDOW_MIN = 12
export const ACTIVITY_SKIP_DIRS = new Set(['.git', 'node_modules', '.pnpm', 'dist', 'build', 'coverage', '.next'])

// This scan can only suppress the advisory: a recent write means work may be in flight, but an
// absent, idle, bounded, or unreadable lane never creates a new block or deny.
export function worktreeActivity(root, cutoff, {
  readdirImpl = readdirSync,
  statImpl = statSync,
} = {}) {
  if (!root) return 'no-root'

  const stack = [root]
  let visited = 0
  while (stack.length > 0) {
    const dir = stack.pop()
    let entries
    try {
      entries = readdirImpl(dir, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      visited += 1
      if (visited > ACTIVITY_MAX_ENTRIES) return 'bounded'
      if (ACTIVITY_SKIP_DIRS.has(entry.name)) continue

      const fullPath = join(dir, entry.name)
      // A lane log is assessed separately: a fresh terminal EXIT marker must not look like work.
      if (entry.name === '.lane' && entry.isDirectory()) {
        stack.push(fullPath)
        continue
      }
      if (fullPath === join(root, '.lane', 'run.log')) continue
      try {
        const info = statImpl(fullPath)
        if (info.mtimeMs >= cutoff) return 'recent'
        if (entry.isDirectory()) stack.push(fullPath)
      } catch {
        continue
      }
    }
  }

  return 'idle'
}

export function registeredWorktrees(root, { spawnSyncImpl = spawnSync } = {}) {
  if (!root) return []
  try {
    const result = spawnSyncImpl('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      timeout: 1_000,
    })
    if (result.status !== 0 || typeof result.stdout !== 'string') return [root]
    const worktrees = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
    return worktrees.length > 0 ? [...new Set(worktrees)] : [root]
  } catch {
    return [root]
  }
}

export function registeredWorktreeActivity(root, cutoff) {
  if (!root) return 'no-root'
  let status = 'idle'
  for (const worktree of registeredWorktrees(root)) {
    const activity = worktreeActivity(worktree, cutoff)
    if (activity === 'recent') return 'recent'
    if (activity === 'bounded') status = 'bounded'
  }
  return status
}

export function hasActiveLaneLog(root, cutoff) {
  if (!root) return false
  for (const worktree of registeredWorktrees(root)) {
    const log = join(worktree, '.lane', 'run.log')
    try {
      if (statSync(log).mtimeMs < cutoff) continue
      const lines = readFileSync(log, 'utf8').trimEnd().split('\n')
      const lastLine = lines.at(-1) || ''
      if (!/^EXIT=\d+$/.test(lastLine)) return true
    } catch {
      // An unreadable lane log is not evidence of liveness.
    }
  }
  return false
}

function laneDirFromArgs(args) {
  const executable = basename(args[0] || '')
  const subcommand = args[1]
  if (!((executable === 'opencode' && subcommand === 'run') || (executable === 'codex' && subcommand === 'exec'))) {
    return null
  }

  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === '--dir' && args[index + 1]) return args[index + 1]
    if (args[index].startsWith('--dir=') && args[index].slice('--dir='.length)) {
      return args[index].slice('--dir='.length)
    }
  }
  return null
}

// /proc is Linux-only. Other platforms, or an unreadable process table, produce an explicit
// unknown so callers never confuse "could not inspect lanes" with "all lanes are idle".
export function scanLiveLaneProcesses({
  procRoot = '/proc',
  platform = process.platform,
  readdirImpl = readdirSync,
  readFileImpl = readFileSync,
} = {}) {
  if (platform !== 'linux') return { status: 'unknown', processes: [] }

  let entries
  try {
    entries = readdirImpl(procRoot)
  } catch {
    return { status: 'unknown', processes: [] }
  }

  const processes = []
  for (const entry of entries) {
    const pid = typeof entry === 'string' ? entry : entry.name
    if (!/^\d+$/.test(pid)) continue
    try {
      const args = Buffer.from(readFileImpl(join(procRoot, pid, 'cmdline'))).toString('utf8').split('\0').filter(Boolean)
      const dir = laneDirFromArgs(args)
      if (dir) processes.push({ pid, dir, command: `${basename(args[0])} ${args[1]}` })
    } catch {
      // A process can exit between /proc's directory read and its cmdline read.
    }
  }
  return { status: 'known', processes }
}
