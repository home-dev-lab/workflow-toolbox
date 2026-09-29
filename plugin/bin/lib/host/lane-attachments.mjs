import { createHash } from 'node:crypto'
import { accessSync, constants as fsConstants, lstatSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { hardenedGitArgs } from './hardened-git.mjs'
import { laneWritablePath, readWorktreeRegular } from './lane-host-dir.mjs'

export const PROJECT_LANE_PREAMBLE = 'lane-brief-preamble.md'
const PROJECT_LANE_FILES = [PROJECT_LANE_PREAMBLE, 'lane-craft-patterns.md']
export const MAX_ATTACHMENT_BYTES = 2 * 1024 * 1024
export const MAX_ATTACHMENTS = 16
const MAX_LANE_COPY_BASENAME = 100
const PREAMBLE_MESSAGE = 'The attached project lane preamble applies to this brief; read it first. Then read and execute the complete brief at'

const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex')

function realpathOrSelf(file) {
  try { return realpathSync(file) } catch { return file }
}

export function laneMessage(readableBrief, preamble) {
  return `${preamble ? PREAMBLE_MESSAGE : 'Read and execute the complete brief at'} ${readableBrief}.`
}

// Refusal text for an explicit --attach value, or null. Not a symlink, a regular readable file, and
// outside everything the lane can write (a lane could otherwise swap the bytes it is handed).
export function explicitAttachRefusal(file, dir, writable) {
  try {
    const info = lstatSync(file)
    if (info.isSymbolicLink()) return `--attach must not be a symbolic link: ${file}`
    if (!info.isFile()) return `--attach is not a regular file: ${file}`
    accessSync(file, fsConstants.R_OK)
  } catch { return `--attach is missing or unreadable: ${file}` }
  if (laneWritablePath(dir, file) || writable(file)) return `--attach must be outside the lane worktree and every lane-writable root: ${file}`
  return null
}

// Bytes of a regular, non-symlinked file read from under `root`; a reason string when it cannot be trusted.
function readSafely(file, root) {
  const bytes = readWorktreeRegular(file, null, root, { unsandboxed: true })
  if (!bytes) return { reason: 'not a regular file, symlinked, or unreadable' }
  if (bytes.length > MAX_ATTACHMENT_BYTES) return { reason: `larger than ${MAX_ATTACHMENT_BYTES} bytes` }
  return { bytes }
}

// The gitfile in the lane worktree names a git dir; that git dir must name the same gitfile back. A
// gitfile hand-written to point at ANOTHER repository's worktree git dir fails the round trip.
function reciprocalPointersMatch(dir) {
  try {
    const own = path.join(dir, '.git')
    const line = readFileSync(own, 'utf8').split(/\r?\n/).find((text) => text.startsWith('gitdir:'))
    const target = line?.slice('gitdir:'.length).trim()
    if (!target) return false
    const gitdir = path.resolve(dir, target)
    const back = readFileSync(path.join(gitdir, 'gitdir'), 'utf8').trim()
    return realpathSync(path.resolve(gitdir, back)) === realpathSync(own)
  } catch { return false }
}

// A lane launched in a main checkout owns its `.git` directory (it could add a `commondir` redirect), so
// only a linked worktree, whose `.git` is a gitfile, is asked for its main checkout. Hardened git config
// and a scrubbed environment keep lane-planted config and hooks from running on the host.
function projectRootOf(dir, run) {
  try {
    const info = lstatSync(path.join(dir, '.git'))
    if (!info.isFile() || info.isSymbolicLink()) return { reason: 'not a linked worktree' }
  } catch { return { reason: 'not a linked worktree' } }
  if (!reciprocalPointersMatch(dir)) return { reason: 'worktree pointers do not match' }
  const result = run('git', hardenedGitArgs(['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir']), { encoding: 'utf8', timeout: 3_000, windowsHide: true, env: { PATH: process.env.PATH ?? '', LC_ALL: 'C', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_NOSYSTEM: '1' } })
  if (result.error || result.status !== 0) {
    const stderrLine = String(result.stderr ?? '').trim().split(/\r?\n/)[0]
    const detail = result.error?.message ?? (stderrLine || `exit ${result.status}`)
    return { reason: `git failed: ${detail}` }
  }
  const common = String(result.stdout ?? '').trim()
  return common && path.basename(common) === '.git' ? { root: path.dirname(common) } : { reason: 'no main checkout found for --dir' }
}

function absent(file) {
  try { lstatSync(file); return false } catch { return true }
}

// Project lane files come from the project's MAIN checkout, never from the lane-writable worktree.
function projectAttachments(dir, writable, run) {
  const skipped = (reason) => ({ items: [], notes: [`project-lane-files=skipped (${reason})`] })
  const { root, reason } = projectRootOf(dir, run)
  if (!root) return skipped(reason)
  const items = []
  const notes = []
  for (const name of PROJECT_LANE_FILES) {
    const file = path.join(root, '.claude', name)
    if (absent(file)) continue
    if (laneWritablePath(dir, file) || writable(file)) { notes.push(`project-lane-files=skipped (${name}: lane-writable location)`); continue }
    const read = readSafely(file, root)
    if (read.reason) { notes.push(`project-lane-files=skipped (${name}: ${read.reason})`); continue }
    items.push({ name, source: file, bytes: read.bytes, sha256: sha256(read.bytes), preamble: name === PROJECT_LANE_PREAMBLE })
  }
  return { items, notes }
}

// Project files first (preamble, then craft patterns), then explicit values; one copy per real file.
export function collectLaneAttachments({ dir, explicit = [], writable = () => false, run = spawnSync }) {
  const project = projectAttachments(dir, writable, run)
  const items = [...project.items]
  for (const file of explicit) {
    const read = readSafely(file, path.dirname(file))
    if (read.reason) return { error: `--attach cannot be read safely (${read.reason}): ${file}` }
    items.push({ name: path.basename(file), source: file, bytes: read.bytes, sha256: sha256(read.bytes), preamble: false })
  }
  const seen = new Set()
  const unique = items.filter((item) => {
    const real = realpathOrSelf(item.source)
    if (seen.has(real)) return false
    seen.add(real)
    return true
  })
  if (unique.length > MAX_ATTACHMENTS) return { error: `at most ${MAX_ATTACHMENTS} attachments are allowed per launch (${unique.length} given, project files included)` }
  return { items: unique, notes: project.notes, preamble: unique.some((item) => item.preamble) }
}

// Host-only snapshots beside the brief snapshot; the receipt entries are what the worker verifies.
export function writeAttachmentSnapshots(items, snapshotDir, runId) {
  const written = []
  try {
    return items.map((item, index) => {
      const snapshot = path.join(snapshotDir, `${runId}-attach-${index}`)
      writeFileSync(snapshot, item.bytes, { flag: 'wx', mode: 0o400 })
      written.push(snapshot)
      return { name: item.name, source: item.source, sha256: item.sha256, snapshot, preamble: item.preamble }
    })
  } catch (error) {
    for (const file of written) rmSync(file, { force: true })
    throw error
  }
}

const plainName = (name) => typeof name === 'string' && name !== '' && name !== '.' && name !== '..' && !/[\\/]/.test(name) && name === path.basename(name)

// Removes ONE run's brief snapshot and its `<runId>-attach-*` snapshots from the host-only snapshot
// directory. Cleanup must never block termination: a failing removal is collected and logged as ONE line.
export function removeRunSnapshots(snapshotDir, runId, { rm = rmSync, log = (line) => process.stderr.write(`${line}\n`) } = {}) {
  const failures = []
  const remove = (file) => { try { rm(file, { force: true }) } catch (error) { failures.push(`${path.basename(file)}: ${error instanceof Error ? error.message : String(error)}`) } }
  remove(path.join(snapshotDir, `${runId}.md`))
  let names = []
  try { names = readdirSync(snapshotDir) } catch { /* nothing to clean */ }
  for (const name of names) if (name.startsWith(`${runId}-attach-`)) remove(path.join(snapshotDir, name))
  if (failures.length) log(`wt-lane: could not remove ${failures.length} run snapshot(s): ${failures.join('; ')}`)
}

// Worker side: never re-reads the caller's sources, only the snapshots the launcher announced at the
// exact host-owned names it gives them (opened without following symlinks), and refuses any byte drift.
export function verifyAttachmentSnapshots(entries, { snapshotDir, runId }) {
  const verified = []
  for (const [index, entry] of (entries ?? []).entries()) {
    if (!plainName(entry.name)) return { error: `Refused: attachment name is not a plain file name: ${JSON.stringify(entry.name)}` }
    if (entry.snapshot !== path.join(snapshotDir, `${runId}-attach-${index}`)) return { error: `Refused: unexpected snapshot path for attachment ${index}: ${entry.snapshot}` }
    const bytes = readWorktreeRegular(entry.snapshot, null, snapshotDir, { unsandboxed: true })
    if (!bytes) return { error: `attachment snapshot is unreadable, not a regular file, or a symlink: ${entry.snapshot}` }
    if (sha256(bytes) !== entry.sha256) return { error: `Refused: attachment snapshot sha256 mismatch for ${entry.snapshot}; refusing to hand the lane bytes other than those announced by the launcher.` }
    verified.push({ name: entry.name, bytes })
  }
  return { verified }
}

// Readable, bounded: a 255-character original name must not push the lane copy past the file-name limit.
function laneCopyName(name) {
  if (name.length <= MAX_LANE_COPY_BASENAME) return name
  const ext = path.extname(name)
  const keep = ext.length <= 16 ? ext : ''
  return `${name.slice(0, MAX_LANE_COPY_BASENAME - keep.length)}${keep}`
}

// Copies verified bytes into the transient, sandbox-readable brief directory; returns the paths for `-f`.
export function copyAttachmentsForLane(verified, directory) {
  return verified.map((item, index) => {
    const copy = path.join(directory, `attach-${index}-${laneCopyName(item.name)}`)
    writeFileSync(copy, item.bytes, { flag: 'wx', mode: 0o400 })
    return copy
  })
}

export function validReceiptAttachments(value) {
  if (value === undefined) return []
  if (!Array.isArray(value)) return null
  const ok = value.every((entry) => typeof entry?.name === 'string' && typeof entry?.source === 'string' && typeof entry?.snapshot === 'string' && /^[0-9a-f]{64}$/.test(entry?.sha256))
  return ok ? value : null
}
