#!/usr/bin/env node

import fs from 'node:fs'
import { analyzeLaneConsent } from './lib/lane-consent-check-core.mjs'

function readInput() {
  try {
    const raw = fs.readFileSync(0, 'utf8')
    return raw ? JSON.parse(raw) : {}
  } catch {
    return {}
  }
}

function main() {
  const input = readInput()
  const root = typeof input.cwd === 'string' && input.cwd ? input.cwd : null
  if (!root) return
  const result = analyzeLaneConsent(root, process.env)
  if (!result.message) return
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'SessionStart',
        additionalContext: result.message,
      },
    }),
  )
}

try {
  main()
} catch (error) {
  // A SessionStart hook must never block a session starting, so this stays fail-open.
  // But a catch that swallows silently makes a broken check indistinguishable from a
  // healthy quiet one — which is the very failure family this check exists to surface.
  // So: fail open, and leave a trace. stderr does not block the session.
  try {
    process.stderr.write(
      `wt-lane-consent-check-hook: FAILED OPEN — ${error instanceof Error ? error.message : String(error)}\n`,
    )
  } catch {
    // Writing the trace must not itself become a reason the session fails to start.
  }
}
