// spill-containment.mjs — bounds on reading a payload the harness diverted to a FILE.
//
// WHY THIS IS ITS OWN MODULE. The hook that uses it executes at import (`runFailOpenHook` runs
// at module scope and reads stdin), so a test importing the hook hangs forever waiting on a
// stdin that never closes. Extracting the decidable part is what makes it testable at all —
// the same reason the other `lib/*-core.mjs` modules here exist.
//
// WHAT IT GUARDS. The harness can answer a large tool call by writing the response to a file
// and handing the hook a PATH. That path arrives inside the tool response, so reading it
// unconditionally lets an untrusted value choose which file this process opens.
//
// Four bounds, and each one is load-bearing:
//   - ABSOLUTE — a relative path resolves against a cwd nobody chose;
//   - INSIDE an allowed root — the harness spills into temp, the state root's parent, and
//     <config>/projects, and nowhere else;
//   - CANONICAL — realpath first, or a symlink inside an allowed root points anywhere. This is
//     the bound that an allow-list without canonicalisation silently fails to provide;
//   - PLAIN FILE, UNDER A CAP — a directory, a device, or a multi-gigabyte file are all read
//     failures rather than payloads.
//
// It returns NULL on every refusal and never throws: the caller's contract is that an
// unreadable spill is recorded as a failed attempt and no snapshot is written from a guess.
// Distinguishing WHY it refused is deliberately not this function's job — the caller already
// classifies an unreadable payload, and a reason string here would need its own escaping rules
// for a path that is, by construction, untrusted input.

import { lstatSync, readFileSync, realpathSync } from 'node:fs'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import { homedir, tmpdir } from 'node:os'
import { stateRoot } from './actionability-state-paths.mjs'

export const DEFAULT_MAX_SPILL_BYTES = 8 * 1024 * 1024

function maxSpillBytes() {
  const raw = Number(process.env.WT_ACTIONABLE_MAX_SPILL_BYTES)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_MAX_SPILL_BYTES
}

/** realpath where possible; `resolve` for a path that does not exist yet, so a missing file is
 *  refused by the lstat below rather than here. */
export function canonicalPath(path) {
  try {
    return realpathSync(path)
  } catch {
    return resolve(path)
  }
}

export function isWithin(root, candidate) {
  const rel = relative(root, candidate)
  if (rel === '') return true
  if (rel === '..' || rel.startsWith('..')) return false
  return !isAbsolute(rel)
}

export function allowedSpillRoots() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || join(homedir(), '.claude')
  return [canonicalPath(tmpdir()), canonicalPath(dirname(stateRoot())), canonicalPath(join(configDir, 'projects'))]
}

/** The spilled payload, or null when the path fails any bound above. Never throws. */
export function readSpilledFileGuarded(path) {
  if (typeof path !== 'string' || path === '' || !isAbsolute(path)) return null
  const canonical = canonicalPath(path)
  if (!allowedSpillRoots().some((root) => isWithin(root, canonical))) return null
  let stat
  try {
    stat = lstatSync(path)
  } catch {
    return null
  }
  if (!stat.isFile() || stat.size > maxSpillBytes()) return null
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}
