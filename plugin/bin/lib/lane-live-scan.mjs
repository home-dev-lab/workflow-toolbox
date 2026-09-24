import { closeSync, existsSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import path, { basename, join } from 'node:path'

export const ACTIVITY_MAX_ENTRIES = 4000
export const ACTIVITY_WINDOW_MIN = 12
export const LANE_LOG_TAIL_BYTES = 4096
export const PROCESS_SCAN_MAX_ENTRIES = 5000
export const ACTIVITY_SKIP_DIRS = new Set(['.git', 'node_modules', '.pnpm', 'dist', 'build', 'coverage', '.next'])

export function reportableOpencodeArgv(argv, { tmpRoot = tmpdir(), realpath = realpathSync } = {}) {
  if (!Array.isArray(argv)) return false
  const opencodeIndex = argv.findIndex((arg, index) => /^(?:opencode|opencode\.exe|opencode\.cmd)$/i.test(String(arg).split(/[\\/]/).at(-1)) && argv[index + 1] === 'run')
  if (opencodeIndex < 0) return false

  const canonicalPath = (value) => {
    let probe = path.resolve(value)
    const suffix = []
    while (true) {
      try { return path.resolve(realpath(probe), ...suffix) } catch {
        const parent = path.dirname(probe)
        if (parent === probe) return path.resolve(value)
        suffix.unshift(path.basename(probe))
        probe = parent
      }
    }
  }
  const canonicalTmp = canonicalPath(tmpRoot)
  const insideTmp = (value) => {
    const relative = path.relative(canonicalTmp, canonicalPath(value))
    return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
  }
  const pathShaped = (value) => /[\\/]/.test(String(value)) || path.isAbsolute(String(value))

  // Only an installed OpenCode `run` invocation is a lane candidate; temp-hosted executables are test fakes.
  return ![argv[0], argv[opencodeIndex]].some((arg) => pathShaped(arg) && insideTmp(arg))
}

function launcherOwnsLog(name) {
  return name === 'run.log'
    || name === 'sdk-pilot.log'
    || name === 'runner-stdout.log'
    || /-run\.log$/.test(name)
    || /-run\..+\.log$/.test(name)
}

function readTail(file, size) {
  const length = Math.min(size, LANE_LOG_TAIL_BYTES)
  const buffer = Buffer.alloc(length)
  const fd = openSync(file, 'r')
  try {
    const bytesRead = readSync(fd, buffer, 0, length, size - length)
    return buffer.subarray(0, bytesRead).toString('utf8')
  } finally {
    closeSync(fd)
  }
}

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
      if (dir === join(root, '.lane') && entry.name.endsWith('.log')) continue
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
  if (!root) return { status: 'no-root', worktrees: [] }
  try {
    const result = spawnSyncImpl('git', ['-C', root, 'worktree', 'list', '--porcelain'], {
      encoding: 'utf8',
      timeout: 1_000,
    })
    if (result.status !== 0 || typeof result.stdout !== 'string') return { status: 'unknown', worktrees: [] }
    const worktrees = result.stdout
      .split('\n')
      .filter((line) => line.startsWith('worktree '))
      .map((line) => line.slice('worktree '.length))
    return worktrees.length > 0
      ? { status: 'known', worktrees: [...new Set(worktrees)] }
      : { status: 'unknown', worktrees: [] }
  } catch {
    return { status: 'unknown', worktrees: [] }
  }
}

export function registeredWorktreeActivity(worktreeScan, cutoff) {
  if (worktreeScan.status !== 'known') return worktreeScan.status
  let status = 'idle'
  for (const worktree of worktreeScan.worktrees) {
    const activity = worktreeActivity(worktree, cutoff)
    if (activity === 'recent') return 'recent'
    if (activity === 'bounded') status = 'bounded'
  }
  return status
}

export function hasActiveLaneLog(worktreeScan, cutoff) {
  if (worktreeScan.status !== 'known') return false
  for (const worktree of worktreeScan.worktrees) {
    let names
    try {
      names = readdirSync(join(worktree, '.lane')).filter(launcherOwnsLog)
    } catch {
      continue
    }
    for (const name of names) {
      const log = join(worktree, '.lane', name)
      try {
        const info = statSync(log)
        if (info.mtimeMs < cutoff) continue
        const lines = readTail(log, info.size).trimEnd().split('\n')
        const lastLine = lines.at(-1) || ''
        if (!/^EXIT=\d+$/.test(lastLine)) return true
      } catch {
        // An unreadable lane log is not evidence of liveness.
      }
    }
  }
  return false
}

// A suite checkout can be an umbrella directory rather than a repository. Its worktrees have a
// stable, project-owned location, so discovering only Git entries directly below that location
// preserves project scope without treating arbitrary sibling directories as activity.
export function suiteUmbrellaWorktrees(root) {
  if (!root) return { status: 'no-root', worktrees: [] }
  const worktreesDir = join(root, '.claude', 'worktrees')
  try {
    const worktrees = readdirSync(worktreesDir, { withFileTypes: true })
      .slice(0, 200)
      .filter((entry) => entry.isDirectory() && existsSync(join(worktreesDir, entry.name, '.git')))
      .map((entry) => join(worktreesDir, entry.name))
    return worktrees.length > 0 ? { status: 'known', worktrees } : { status: 'no-root', worktrees: [] }
  } catch {
    return { status: 'no-root', worktrees: [] }
  }
}

export function stagingLaneDirs(root) {
  if (!root) return []
  const worktreesDir = join(root, '.claude', 'worktrees')
  try {
    return readdirSync(worktreesDir, { withFileTypes: true })
      .slice(0, 200)
      .filter((entry) => entry.isDirectory() && /^.+-\d{10}$/.test(entry.name) && existsSync(join(worktreesDir, entry.name, '.lane', 'brief.md')))
      .map((entry) => join(worktreesDir, entry.name))
  } catch {
    return []
  }
}

function laneDirFromArgs(args, pathApi = path) {
  const executable = pathApi.basename(args[0] || '')
  const subcommand = args[1]
  const script = args.find((arg) => ['wt-pilot-runner.mjs', 'wt-lane.mjs'].includes(pathApi.basename(arg)))
  if (!script && !((executable === 'opencode' && subcommand === 'run') || (executable === 'codex' && subcommand === 'exec'))) {
    return null
  }

  for (let index = 2; index < args.length; index += 1) {
    if (args[index] === '--dir' && pathApi.isAbsolute(args[index + 1] || '')) return args[index + 1]
    if (args[index].startsWith('--dir=') && args[index].slice('--dir='.length)) {
      const dir = args[index].slice('--dir='.length)
      return pathApi.isAbsolute(dir) ? dir : null
    }
  }
  return null
}

function windowsCommandArgs(commandLine) {
  const args = []
  const pattern = /"((?:\\.|[^"])*)"|(\S+)/g
  for (const match of String(commandLine).matchAll(pattern)) args.push((match[1] ?? match[2]).replace(/\\"/g, '"'))
  return args
}

export function posixCommandArgs(commandLine) {
  const args = []
  const pattern = /"((?:\\.|[^"])*)"|'((?:\\.|[^'])*)'|((?:\\.|[^\s])+)/g
  for (const match of String(commandLine).matchAll(pattern)) args.push((match[1] ?? match[2] ?? match[3]).replace(/\\([\\"' ])/g, '$1'))
  return args
}

const DARWIN_PROCESS_SCAN_TTL_MS = 100
const darwinProcessScanCache = new WeakMap()

function scanDarwinLaneProcesses(spawnSyncImpl, now = Date.now()) {
  const cached = darwinProcessScanCache.get(spawnSyncImpl)
  if (cached && now - cached.readAt <= DARWIN_PROCESS_SCAN_TTL_MS) return cached.result
  let result
  try {
    result = spawnSyncImpl('ps', ['-axo', 'pid=,command='], { encoding: 'utf8', timeout: 5_000, env: { ...process.env, LC_ALL: 'C' } })
  } catch {
    result = { status: 'unknown', processes: [], source: 'ps' }
    darwinProcessScanCache.set(spawnSyncImpl, { readAt: now, result })
    return result
  }
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    result = { status: 'unknown', processes: [], source: 'ps' }
    darwinProcessScanCache.set(spawnSyncImpl, { readAt: now, result })
    return result
  }
  const rows = result.stdout.split(/\r?\n/).map((line) => /^\s*(\d+)\s+(.+)$/.exec(line)).filter(Boolean)
  const processes = []
  for (const row of rows.slice(0, PROCESS_SCAN_MAX_ENTRIES)) {
    const args = posixCommandArgs(row[2])
    const dir = laneDirFromArgs(args)
    if (dir) processes.push({ pid: row[1], dir, command: args.map((arg) => basename(arg)).slice(0, 2).join(' ') })
  }
  result = { status: rows.length > PROCESS_SCAN_MAX_ENTRIES ? 'capped' : 'known', processes }
  darwinProcessScanCache.set(spawnSyncImpl, { readAt: now, result })
  return result
}

function scanWindowsLaneProcesses(spawnSyncImpl, win32Path) {
  const script = "Get-CimInstance Win32_Process | Where-Object { $_.Name -eq 'node.exe' -or $_.Name -eq 'node' } | Select-Object ProcessId,CommandLine | ConvertTo-Json -Compress"
  let result
  try {
    result = spawnSyncImpl('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
      encoding: 'utf8',
      timeout: 5_000,
      windowsHide: true,
    })
  } catch {
    return { status: 'unknown', processes: [], source: 'powershell' }
  }
  if (result.error || result.status !== 0 || typeof result.stdout !== 'string') {
    return { status: 'unknown', processes: [], source: 'powershell' }
  }
  let rows
  try {
    const parsed = result.stdout.trim() ? JSON.parse(result.stdout) : []
    rows = Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return { status: 'unknown', processes: [], source: 'powershell' }
  }
  const processes = []
  for (const row of rows.slice(0, PROCESS_SCAN_MAX_ENTRIES)) {
    if (!row || typeof row.CommandLine !== 'string' || !Number.isSafeInteger(Number(row.ProcessId))) continue
    const args = windowsCommandArgs(row.CommandLine)
    const dir = laneDirFromArgs(args.map((arg) => arg.replaceAll('/', () => win32Path.sep)), win32Path)
    if (dir && win32Path.isAbsolute(dir)) processes.push({ pid: String(row.ProcessId), dir, command: args.map((arg) => win32Path.basename(arg)).slice(0, 2).join(' ') })
  }
  return { status: rows.length > PROCESS_SCAN_MAX_ENTRIES ? 'capped' : 'known', processes }
}

// /proc is Linux-only. Other platforms, or an unreadable process table, produce an explicit
// unknown so callers never confuse "could not inspect lanes" with "all lanes are idle".
export function scanLiveLaneProcesses({
  procRoot = '/proc',
  platform = process.platform,
  readdirImpl = readdirSync,
  readFileImpl = readFileSync,
  spawnSyncImpl = spawnSync,
  win32Path = path.win32,
} = {}) {
  if (platform === 'win32') return scanWindowsLaneProcesses(spawnSyncImpl, win32Path)
  if (platform === 'darwin') return scanDarwinLaneProcesses(spawnSyncImpl)
  if (platform !== 'linux') return { status: 'unknown', processes: [] }

  let entries
  try {
    entries = readdirImpl(procRoot)
  } catch {
    return { status: 'unknown', processes: [] }
  }

  const processes = []
  let numericEntries = 0
  let capped = false
  for (const entry of entries) {
    const pid = typeof entry === 'string' ? entry : entry.name
    if (!/^\d+$/.test(pid)) continue
    numericEntries += 1
    if (numericEntries > PROCESS_SCAN_MAX_ENTRIES) {
      capped = true
      break
    }
    try {
      const args = Buffer.from(readFileImpl(join(procRoot, pid, 'cmdline'))).toString('utf8').split('\0').filter(Boolean)
      const dir = laneDirFromArgs(args)
      if (dir) processes.push({ pid, dir, command: args.map((arg) => basename(arg)).slice(0, 2).join(' ') })
    } catch {
      // A process can exit between /proc's directory read and its cmdline read.
    }
  }
  return { status: capped ? 'capped' : 'known', processes }
}
