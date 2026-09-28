// Shared gate-record format and tree signature. Ignored files are outside the signature by design,
// as they are outside the commit too; lifecycle evidence under .lane/ relies on that exclusion.
import { createHash } from 'node:crypto'
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { defaultGuardJournalDir } from './guard-journal-read.mjs'

function git(root, args) {
  return execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
}

function gitOrEmpty(root, args) {
  try { return git(root, args) } catch { return '' }
}

export function repoRoot(cwd) {
  return (fs.realpathSync.native ?? fs.realpathSync)(git(cwd, ['rev-parse', '--show-toplevel']).trim())
}

/** null when the repository declares no gates — the guard is opt-in by that file, and an absent file
 *  must read as "not declared", never as a fail-open trace on every commit in every other repository. */
export function readGateDeclaration(root) {
  const file = path.join(root, '.wt-gates.json')
  if (!fs.existsSync(file)) return null
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
  if (!Array.isArray(parsed?.gates) || !Array.isArray(parsed?.paths)) throw new Error('invalid .wt-gates.json')
  return parsed
}

// Shared by treeSignature() and treeEntryDigests() below — the ONE place that decides which
// names participate in a tree signature (tracked + HEAD + untracked-non-ignored). A second,
// independently maintained name-collection routine is exactly the drift this file exists to
// prevent (step-back-architectural: fix the shared root, don't re-derive it per caller).
function collectTreeNames(root) {
  // The signature describes the filesystem, not the index. Include HEAD names so
  // staging a deletion or rename cannot change the set being compared.
  return [...new Set([
    ...gitOrEmpty(root, ['ls-tree', '-r', '--name-only', 'HEAD', '-z']).split('\0'),
    ...git(root, ['ls-files', '--cached', '-z']).split('\0'),
    ...git(root, ['ls-files', '--others', '--exclude-standard', '-z']).split('\0'),
  ])].filter(Boolean).sort()
}

export function treeSignature(root, fileSystem = fs) {
  const hash = createHash('sha256')
  hash.update('wt-tree-signature-v3\0')
  for (const name of collectTreeNames(root)) {
    const file = path.join(root, name)
    const stat = fileSystem.lstatSync(file, { throwIfNoEntry: false })
    if (!stat) continue
    hash.update(Buffer.from(name)); hash.update('\0')
    hash.update(`${stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other'}\0${stat.mode & 0o7777}\0`)
    if (stat.isFile()) hash.update(fileSystem.readFileSync(file))
    else if (stat.isSymbolicLink()) hash.update(fileSystem.readlinkSync(file))
    else throw new Error(`unsupported repository entry: ${name}`)
    hash.update('\0')
  }
  return hash.digest('hex')
}

/** Per-file digests for the SAME tree walk treeSignature() does (same collectTreeNames(), same
 *  kind+mode+content recipe per entry) — used only to name WHICH paths differ between two
 *  moments in time. Never a second, independently maintained signature algorithm: treeSignature()
 *  above is untouched and still the one value persisted to a gate record's `tree` field. A
 *  missing entry (deleted since the name was listed) is recorded as `null` so its absence is
 *  itself a detectable difference, not silently skipped. */
export function treeEntryDigests(root, fileSystem = fs) {
  const entries = new Map()
  for (const name of collectTreeNames(root)) {
    const file = path.join(root, name)
    const stat = fileSystem.lstatSync(file, { throwIfNoEntry: false })
    if (!stat) { entries.set(name, null); continue }
    const hash = createHash('sha256')
    hash.update(`${stat.isFile() ? 'file' : stat.isSymbolicLink() ? 'symlink' : 'other'}\0${stat.mode & 0o7777}\0`)
    if (stat.isFile()) hash.update(fileSystem.readFileSync(file))
    else if (stat.isSymbolicLink()) hash.update(fileSystem.readlinkSync(file))
    else throw new Error(`unsupported repository entry: ${name}`)
    entries.set(name, hash.digest('hex'))
  }
  return entries
}

/** Sorted list of every name whose digest differs between two treeEntryDigests() snapshots
 *  (added, removed, or content/mode changed) — the names a caller reports, bounded by the
 *  caller to a small count. */
export function diffTreeEntryDigests(before, after) {
  const names = new Set([...before.keys(), ...after.keys()])
  return [...names].sort().filter((name) => before.get(name) !== after.get(name))
}

export function recordPath(root, name) {
  const repoId = createHash('sha256').update(root).digest('hex')
  return path.join(defaultGuardJournalDir(), 'wt-gate-records', repoId, `${name}.json`)
}

export function writeGateRecord(root, record) {
  const target = recordPath(root, record.name)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.writeFileSync(target, `${JSON.stringify(record)}\n`)
  return target
}

export function readGateRecord(root, name) {
  try {
    return JSON.parse(fs.readFileSync(recordPath(root, name), 'utf8'))
  } catch {
    return null
  }
}

export function stagedPaths(root) {
  return git(root, ['diff', '--cached', '--name-only', '-z']).split('\0').filter(Boolean)
}

export function touchesDeclaredPath(paths, declaredPaths) {
  return paths.some((file) => declaredPaths.some((prefix) => file.startsWith(prefix)))
}

function recordIsFresh(root, record, signature, paths, gitRunner = git) {
  if (!record || record.version !== 2 || record.exit !== 0 || record.tree !== signature) return false
  if (paths.length === 0) return true
  try {
    // diff-files compares index bytes, type and executable bit with the worktree, including
    // unstaged deletions. A file removed from both index and disk before the gate, then
    // restored on disk afterward, changes the signature because HEAD names remain in its walk.
    // --quiet short-circuits on a stat-only change (including a future-dated touch);
    // the patch form actually compares the bytes and modes before deciding. Bound argv size.
    for (let offset = 0; offset < paths.length; offset += 100) {
      const literals = paths.slice(offset, offset + 100).map((file) => `:(literal)${file}`)
      if (gitRunner(root, ['-c', 'core.filemode=true', 'diff', '--no-ext-diff', '--no-textconv', '--binary', '--', ...literals]) !== '') return false
    }
    return true
  } catch {
    // An unreadable index or worktree is never fresh.
    return false
  }
}

export function requiredGateProblems(root, declaration, { signature, paths = [], pushedCommit = null, gitRunner = git } = {}) {
  return declaration.gates.flatMap((gate) => {
    const record = readGateRecord(root, gate.name)
    if (!record) return [{ gate, status: 'MISSING' }]
    if (record.exit !== 0) return [{ gate, status: `RED (exit ${record.exit})` }]
    if (pushedCommit) {
      if (record.version !== 2) return [{ gate, status: 'STALE (record predates version 2)' }]
      return record.version === 2 && record.head === pushedCommit && record.dirty === false
        ? []
        : [{ gate, status: 'STALE (recorded tree does not match pushed commit)' }]
    }
    return recordIsFresh(root, record, signature, paths, gitRunner)
      ? []
      : [{ gate, status: 'STALE (signature differs or staged file changed after gate)' }]
  })
}

// Gate environment: the environment a run's gates (`pnpm typecheck|lint|test` over the delivery) receive.
//
// WT_* is the toolbox's own configuration namespace. The operator sets such variables for the RUNNER
// (WT_AGENT_SDK_PATH, WT_EXECUTOR_*_MODEL, WT_RUN_PIECES_TESTED, WT_PLANKA_MCP_URL, ...); the gates test
// the toolbox itself, so any of them reaching the delivery's suite makes its verdict depend on how the
// runner was launched (WT_AGENT_SDK_PATH, set to reach a newer SDK, turned two correct tests red).
// Every WT_* key is therefore dropped, except the ones that configure the GATE machinery rather than
// the product under test. Everything outside WT_* (PATH, HOME, locale, temp, Windows system keys)
// passes unchanged: a gate cannot run without it, and an allow-list of it would differ per platform.
const GATE_WT_KEYS = Object.freeze([
  'WT_SUITE_LOCK', // `0` bypasses the machine-wide suite lock (wt-suite-lock.mjs)
  'WT_SUITE_LOCK_CMD', // the lock runner a lane invokes (wt-suite-lock-run.mjs)
  'WT_SUITE_LOCK_DIR', // where the suite lock lives
  'WT_SUITE_LOCK_TIMEOUT', // how long a suite waits for the lock
  'WT_TEST_MODE', // vitest.config.mts: all | blocking | quarantine
  'WT_VITEST_MAX_WORKERS', // vitest.config.mts: worker ceiling on a loaded machine
])

const KEEP = new Set(GATE_WT_KEYS)

export function gateEnvironment(env = process.env) {
  const result = {}
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) continue
    if (/^WT_/i.test(key) && !KEEP.has(key.toUpperCase())) continue
    result[key] = value
  }
  return result
}
