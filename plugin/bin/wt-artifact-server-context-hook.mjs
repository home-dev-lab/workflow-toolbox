#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { probeArtifactServer, readArtifactDiscovery } from './lib/artifact-server.mjs'
import { isCompactSource } from './lib/session-start-source.mjs'

// The session's own shell does not carry CLAUDE_PLUGIN_ROOT, so the announced command names
// the binary beside this hook by its resolved absolute path.
const SERVER_BIN = join(dirname(fileURLToPath(import.meta.url)), 'wt-artifact-server.mjs')

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  // A compaction re-runs SessionStart; the artifact-server line is start-of-session information.
  if (!input?.agent_id && !isCompactSource(input)) {
    const deadline = Date.now() + 1_000
    let state = null
    while (Date.now() < deadline && !state) {
      state = readArtifactDiscovery()
      if (!state) await new Promise((resolve) => setTimeout(resolve, 50))
    }
    let context = 'Artifact server status is unknown: no live server was verified, so do not hand out an artifact-server link.'
    if (state) {
      const probe = await probeArtifactServer(state.port)
      if (probe.kind === 'ours' && probe.health.pid === state.pid) {
        context = `Artifact server is running: before handing the user a report or artifact path, run node "${SERVER_BIN}" url "<absolute-file-path>" and hand over the clickable link.`
      }
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }))
  }
} catch {}
