#!/usr/bin/env node

import fs from 'node:fs'
import { analyzeLaneConsent } from './lib/lane-consent-check-core.mjs'
import { runFailOpenHook } from './lib/fail-open-trace.mjs'

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

runFailOpenHook('wt-lane-consent-check-hook.mjs', main)
