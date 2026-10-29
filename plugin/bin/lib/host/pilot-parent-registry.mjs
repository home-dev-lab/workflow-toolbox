import { readFileSync, readdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

function sessionEntries(directory, fs) {
  try { return fs.readdirSync(directory, { withFileTypes: true }) } catch { return [] }
}

function parentEntry(directory, entry, parentName, fs) {
  if (!/^\d+\.json$/u.test(entry.name) || !entry.isFile()) return false
  try { return JSON.parse(fs.readFileSync(join(directory, entry.name), 'utf8'))?.name === parentName } catch { return false }
}

// Peer registries share a directory with credential files: never open a sibling by suffix alone.
export function assertParentRegistry(parentSession, env, fs = { readFileSync, readdirSync }) {
  const home = process.platform === 'win32' ? env.USERPROFILE : env.HOME
  const config = env.CLAUDE_CONFIG_DIR || join(home || homedir(), '.claude')
  const directory = join(config, 'sessions')
  const parentName = parentSession.replace(/ \[[0-9a-f]+\]$/u, '')
  if (sessionEntries(directory, fs).some((entry) => parentEntry(directory, entry, parentName, fs))) return
  throw new Error(`parent session not found in config directory ${config}; set CLAUDE_CONFIG_DIR to the parent's config directory (including in --profile-env), then rerun wt-pilot-runner.mjs`)
}
