#!/usr/bin/env node
// SessionStart warning for work captured while the Planka MCP was unavailable.
// This is advisory only: every failure path stays silent and exits successfully.

import fs from 'node:fs'
import path from 'node:path'

function readStdinJson() {
  try {
    const parsed = JSON.parse(fs.readFileSync(0, 'utf8'))
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function unsyncedEntryCount(content) {
  const heading = /^## Unsynced \(Planka down\)\s*$/m.exec(content)
  if (!heading || heading.index === undefined) return null

  const section = content.slice(heading.index + heading[0].length).split(/^##\s+/m, 1)[0]
  return (section.match(/^\s*(?:[-*+] |\d+[.)] )/gm) ?? []).length
}

function main() {
  try {
    const payload = readStdinJson()
    const cwd = typeof payload.cwd === 'string' && payload.cwd.trim() !== '' ? payload.cwd : process.cwd()
    const progressPath = path.join(cwd, '.claude', 'progress.md')
    const count = unsyncedEntryCount(fs.readFileSync(progressPath, 'utf8'))
    if (count === null) return

    console.log(
      `[wt] LOUD: ${count} unsynced ${count === 1 ? 'entry' : 'entries'} in ${progressPath}; fold them back into the board and purge the section.`,
    )
  } catch {
    // A session-start warning must never delay or prevent a session from starting.
  }
}

main()
