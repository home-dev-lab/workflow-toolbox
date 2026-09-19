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

import { dirname, join } from 'node:path'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { pluginName, resolvePluginDataDir } from './plugin-data-dir.mjs'

// An ABSOLUTE path resolved from this module, never `${CLAUDE_PLUGIN_ROOT}`: that variable is empty in the
// main session's shell, so a command printed with it fails exactly where a session is told to run it.
export const ACTIONABLE_REFRESH_COMMAND = `node "${join(dirname(fileURLToPath(import.meta.url)), '..', 'wt-actionable-snapshot-refresh.mjs')}"`

// XDG_STATE_HOME with the documented ~/.local/state fallback — matches every
// other wt-* state directory on this machine (see machine-calibrations.md).
export function stateRoot() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return resolvePluginDataDir({ fallback: join(base, 'wt-actionable'), pluginName: pluginName() }).dir
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
