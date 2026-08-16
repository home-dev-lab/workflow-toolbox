// prior-art-state-paths.mjs — the ONE place the per-project card-title index
// (consumed by wt-prior-art-launch-guard-hook.mjs, written by
// wt-actionable-snapshot-producer-hook.mjs) computes its on-disk location.
//
// WHY A SEPARATE STATE ROOT FROM ~/.local/state/wt-actionable. That directory
// already holds a durable contract between a producer and a consumer, but it
// is a DIFFERENT contract (the actionability snapshot: is anything startable
// right now). This index answers a different question (what does the board
// call things named like the command about to run) and has a different
// shape, a different cap, and a different consumer. Sharing a directory would
// couple two schemas that evolve for unrelated reasons; a dedicated root
// keeps the two producers free to change their own file shape without
// auditing the other's reader.
//
// projectSlug() is intentionally the SAME derivation as
// actionability-state-paths.mjs (every character outside [A-Za-z0-9-]
// replaced by '-') — imported from there rather than re-implemented, so a
// project has one slugging rule across every wt-* state directory rather
// than one per consumer (see that file's own header for the same point).

import { join } from 'node:path'
import { homedir } from 'node:os'
import { projectSlug } from './actionability-state-paths.mjs'

export { projectSlug }

// XDG_STATE_HOME with the documented ~/.local/state fallback — matches every
// other wt-* state directory on this machine (see machine-calibrations.md).
export function stateRoot() {
  const base = process.env.XDG_STATE_HOME || join(homedir(), '.local', 'state')
  return join(base, 'wt-prior-art')
}

export function cardIndexPath(root, cwd) {
  return join(root, `${projectSlug(cwd)}.json`)
}
