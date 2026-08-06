// actionability-state-paths.mjs — the ONE place the actionability snapshot's
// on-disk location is computed. Both the consumer (wt-actionable-gate-hook.mjs)
// and any producer (wt-actionable-snapshot-producer-hook.mjs, or a project's own
// writer) import this instead of re-deriving the path, so the two sides of the
// contract cannot silently drift onto different files.
//
// Extracted 2026-08-06 (card 1835531703): before this file existed, the
// consumer computed stateRoot()/projectSlug()/snapshotPath() inline and no
// producer existed to duplicate them — but the card's own text called out the
// risk by name ("don't hand-roll a second path-resolution routine that could
// drift from the consumer's"), so the seam is created before it is needed
// twice, not after.

import { join } from 'node:path'
import { homedir } from 'node:os'

// XDG_STATE_HOME with the documented ~/.local/state fallback — matches every
// other wt-* state directory on this machine (see machine-calibrations.md).
export function stateRoot() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'wt-actionable')
}

// The project slug is the project's cwd with every character outside
// [A-Za-z0-9-] replaced by '-' — same derivation used for the knowledge-base
// index path elsewhere on this machine, kept consistent so a project has ONE
// slugging rule rather than one per consumer.
export function projectSlug(cwd) {
  return String(cwd).replace(/[^A-Za-z0-9-]/g, '-')
}

export function snapshotPath(root, cwd) {
  return join(root, `${projectSlug(cwd)}.json`)
}

export function projectStatePath(root, cwd) {
  return join(root, `${projectSlug(cwd)}.project-state.json`)
}

export function sessionStatePath(root, cwd, sessionId) {
  const safeSessionId = String(sessionId || 'unknown').replace(/[^A-Za-z0-9._-]/g, '-')
  return join(root, `${projectSlug(cwd)}--${safeSessionId}.session-state.json`)
}
