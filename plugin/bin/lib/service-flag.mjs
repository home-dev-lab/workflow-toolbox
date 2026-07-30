// service-flag.mjs — shared reader for the Anthropic-service-degraded flag.
//
// WHAT IT IS FOR. wt-service-watch.mjs writes a small JSON flag when the
// Anthropic status page reports the API or Claude Code as degraded. Any other
// monitor (wt-arc-watch.mjs today, more later) reads it through THIS module so
// the "what counts as degraded" logic lives in exactly one place.
//
// FAIL OPEN, ALWAYS. A missing file, an unreadable file, malformed JSON, or an
// expired `expiresAt` all mean the SAME thing: not degraded. A reader that
// throws or that treats a broken flag as "degraded" would let a corrupted file
// silence every other monitor forever — worse than no flag at all.

import { readFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import path from 'node:path'

/** Default path of the flag file, honouring CLAUDE_CONFIG_DIR like the rest of the plugin. */
export function defaultFlagPath() {
  const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(homedir(), '.claude')
  return path.join(configDir, '.wt-service-degraded.json')
}

/**
 * Returns the parsed flag object when the service is currently degraded, or
 * `false` otherwise (no file, unreadable, malformed, or expired).
 *
 * @param {string} [flagPath] defaults to defaultFlagPath()
 */
export async function isServiceDegraded(flagPath = defaultFlagPath()) {
  let raw
  try {
    raw = await readFile(flagPath, 'utf8')
  } catch {
    // ENOENT, EACCES, or anything else: no usable flag → not degraded.
    return false
  }

  let flag
  try {
    flag = JSON.parse(raw)
  } catch {
    return false
  }

  if (!flag || typeof flag !== 'object') return false

  const expiresAt = Date.parse(flag.expiresAt)
  if (!Number.isFinite(expiresAt)) return false
  if (Date.now() >= expiresAt) return false

  return flag
}
