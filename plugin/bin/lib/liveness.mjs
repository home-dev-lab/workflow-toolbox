import { lstat, readdir, readFile } from 'node:fs/promises'
import path from 'node:path'

// liveness — the THIRD input wt-arc-watch.mjs consults when a transcript's mtime already says
// "this agent has gone quiet" and the outbound-guard journal still does NOT account for that
// silence as a benign end-of-turn stop.
//
// WHY THIS EXISTS. A SubagentStop record is emitted at every turn boundary, whether the delegate
// is ACTUALLY done or merely asleep between turns with work still outstanding. That means the
// stop-correlation discriminator can only answer "did a clean turn boundary happen?" — not the
// harder question the reader actually cares about after an overnight stall: "was that boundary
// the end of the mission, or just the last time the delegate was heard from before it drifted
// idle?" Only the delegate itself knows that state, so the delegate may leave a tiny explicit
// declaration on disk for the watcher to read.
//
// FAILS TOWARD ALERTING, NEVER TOWARD SILENCE. This module is deliberately asymmetric: every
// absent file, malformed JSON blob, unreadable directory, schema mismatch, or unscannable
// worktree MUST degrade to "unknown / not recently active" rather than "complete" or
// "recently active". The watcher already had a safe default before this file existed — emit
// STALE. Any ambiguity introduced here must fall back to that existing alerting path, or at worst
// to the new explicit IDLE-MID-MISSION alert. The one thing it must never do is suppress a real
// stall because some side input COULD NOT be checked.
//
// CROSS-PLATFORM CONSTRAINTS. This helper is intentionally limited to path arithmetic plus
// node:fs/promises calls. No /proc, no lsof/netstat/ss, no socket assumptions, no permission-bit
// logic that only means one thing on POSIX. Even the delegate-supplied filename key is treated as
// hostile input: names arrive through spawn briefs, so they are sanitized to a Windows/macOS/Linux
// safe subset before ever becoming a path segment. worktreeRecentlyActive() uses lstat on every
// entry specifically so a symlink is never followed into some other tree the delegate merely
// pointed at.

export function defaultLivenessDir(homedir) {
  return path.join(homedir, '.local', 'state', 'wt-liveness')
}

export function sanitizeLivenessKey(name) {
  const trimmed = String(name).trim()
  if (!trimmed) return null
  return trimmed.replace(/[^A-Za-z0-9_.-]/g, '-').slice(0, 120)
}

export function validateLivenessRecord(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ok: false, reason: 'record' }
  const agentIdSource = parsed.agentIdSource === undefined ? 'unknown' : parsed.agentIdSource
  if (!['brief', 'name', 'none', 'unknown'].includes(agentIdSource)) return { ok: false, reason: 'agentIdSource' }

  const agentId = typeof parsed.agentId === 'string' && parsed.agentId.trim() ? parsed.agentId : null
  if (!agentId && agentIdSource !== 'none') return { ok: false, reason: 'agentId' }
  const scope = typeof parsed.scope === 'string' && parsed.scope.trim() ? parsed.scope : null
  if (!scope) return { ok: false, reason: 'scope' }

  const waitingOn = parsed.waitingOn === undefined ? 'none' : parsed.waitingOn
  if (!['none', 'lane', 'spawner'].includes(waitingOn)) return { ok: false, reason: 'waitingOn' }

  if (parsed.worktree !== undefined && parsed.worktree !== null && typeof parsed.worktree !== 'string') {
    return { ok: false, reason: 'worktree' }
  }
  // A RELATIVE worktree path is not rejected outright (that would also lose a legitimate
  // complete:true record over an unrelated field) — it is silently downgraded to null instead.
  // `worktreeRecentlyActive()` resolves its argument against the WATCHER PROCESS's own cwd when
  // given a relative path, not the delegate's actual tree — a delegate writing `worktree: "."`
  // (accidentally, or a stale/copy-pasted record) would then have the watcher's OWN directory
  // checked for recent activity, which is almost always true inside an active repo, silencing a
  // genuinely stale transcript. Nulling it out here means the caller's `waitingOn:"lane"` branch
  // requires a truthy `worktree` and finds none, falling through to IDLE-MID-MISSION — safe,
  // per this module's fails-toward-alerting contract.
  const worktree = typeof parsed.worktree === 'string' && path.isAbsolute(parsed.worktree)
    ? parsed.worktree
    : null

  return {
    ok: true,
    record: {
      agentId,
      agentIdSource,
      scope,
      complete: parsed.complete === true,
      waitingOn,
      worktree,
      updatedAt: typeof parsed.updatedAt === 'string' ? parsed.updatedAt : null,
    },
  }
}

// `key` is assumed to ALREADY be sanitized by the caller. This function does not re-sanitize it;
// passing an unsanitized key is a caller bug, not a recoverable condition this helper tries to
// guess around.
export async function readLivenessRecord(dir, key) {
  try {
    const raw = await readFile(path.join(dir, `${key}.json`), 'utf8')
    const parsed = JSON.parse(raw)
    const validated = validateLivenessRecord(parsed)
    return validated.ok ? validated.record : null
  } catch {
    return null
  }
}

/**
 * Answers "has ANY regular file under worktreePath been modified at or after sinceMs?"
 *
 * CALLER SAFETY RULE: `null` means the ROOT of the worktree could not be read at all
 * (missing, unreadable, not a directory). The caller MUST treat that the same as `false` for
 * alerting purposes — i.e. NEVER as recently active. Returning `null` here is an explicit
 * "unknown" so that a caller cannot accidentally confuse "scan found nothing" with "the scan
 * could not even start", but BOTH outcomes fail toward alerting, not toward silence.
 */
export async function worktreeRecentlyActive(worktreePath, sinceMs, opts = {}) {
  const maxEntries = Number.isFinite(opts.maxEntries) && opts.maxEntries > 0 ? opts.maxEntries : 4000

  let rootInfo
  try {
    rootInfo = await lstat(worktreePath)
  } catch {
    return null
  }
  if (!rootInfo.isDirectory()) return null

  const pending = [worktreePath]
  let visited = 0

  while (pending.length > 0) {
    const dir = pending.pop()
    let names
    try {
      names = await readdir(dir)
    } catch {
      return false
    }
    for (const name of names) {
      visited += 1
      if (visited > maxEntries) return false
      const full = path.join(dir, name)
      let info
      try {
        info = await lstat(full)
      } catch {
        continue
      }
      if (info.isDirectory()) {
        if (name === '.git' || name === 'node_modules') continue
        pending.push(full)
        continue
      }
      if (info.isFile() && info.mtimeMs >= sinceMs) return true
    }
  }

  return false
}
