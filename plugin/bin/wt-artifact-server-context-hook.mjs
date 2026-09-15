#!/usr/bin/env node

import { readFileSync } from 'node:fs'
import { probeArtifactServer, readArtifactDiscovery } from './lib/artifact-server.mjs'

try {
  const input = JSON.parse(readFileSync(0, 'utf8') || '{}')
  if (!input?.agent_id) {
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
        context = 'Artifact server is running: before handing the user a report or artifact path, run node "${CLAUDE_PLUGIN_ROOT}/bin/wt-artifact-server.mjs" url "<absolute-file-path>" and hand over the clickable link.'
      }
    }
    process.stdout.write(JSON.stringify({
      hookSpecificOutput: { hookEventName: 'SessionStart', additionalContext: context },
    }))
  }
} catch {}
